// Shared deterministic wire fixture. This is test infrastructure, never a Forge execution provider.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

export type FixtureReply =
  { tool: string; id: string; input: Record<string, unknown> } | { text: string };
export async function fixtureProvider(
  protocol: 'responses' | 'messages' | 'chat',
  program: (body: any) => FixtureReply,
  expectedKey?: string,
) {
  let requests = 0;
  let failure: string | null = null;
  const server = createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes < 8 * 1024 * 1024, 'Fixture request exceeds its bound.');
        chunks.push(Buffer.from(chunk));
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (request.url?.includes('/count_tokens')) {
        reply.setHeader('content-type', 'application/json');
        reply.end('{"input_tokens":10}');
        return;
      }
      if (!request.url?.startsWith(`/v1/${protocol === 'chat' ? 'chat/completions' : protocol}`)) {
        reply.setHeader('content-type', 'application/json');
        reply.end('{}');
        return;
      }
      if (expectedKey)
        assert.equal(
          protocol === 'chat' ? request.headers.authorization : request.headers['x-api-key'],
          protocol === 'chat' ? `Bearer ${expectedKey}` : expectedKey,
          'The selected synthetic native credential did not reach its provider.',
        );
      requests++;
      const action = program(body);
      const tool = 'tool' in action;
      const emit = (value: { type: string; [key: string]: unknown }) =>
        reply.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (protocol === 'chat') {
        const base = {
          id: `chatcmpl-fixture-${requests}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
        };
        const call = tool
          ? {
              id: action.id,
              type: 'function',
              function: { name: action.tool, arguments: JSON.stringify(action.input) },
            }
          : null;
        const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
        const finish_reason = tool ? 'tool_calls' : 'stop';
        if (!body.stream) {
          reply.setHeader('content-type', 'application/json');
          reply.end(
            JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: tool ? null : action.text,
                    ...(call ? { tool_calls: [call] } : {}),
                  },
                  finish_reason,
                },
              ],
              usage,
            }),
          );
          return;
        }
        reply.setHeader('content-type', 'text/event-stream');
        const delta = tool
          ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] }
          : { role: 'assistant', content: action.text };
        reply.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        reply.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\n`,
        );
        reply.write('data: [DONE]\n\n');
      } else if (protocol === 'messages') {
        const content = tool
          ? { type: 'tool_use', id: action.id, name: action.tool, input: action.input }
          : { type: 'text', text: action.text };
        const message = {
          id: `msg-fixture-${requests}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [content],
          stop_reason: tool ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 8 },
        };
        if (!body.stream) {
          reply.setHeader('content-type', 'application/json');
          reply.end(JSON.stringify(message));
          return;
        }
        reply.setHeader('content-type', 'text/event-stream');
        emit({
          type: 'message_start',
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        emit({
          type: 'content_block_start',
          index: 0,
          content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' },
        });
        emit({
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(action.input) }
            : { type: 'text_delta', text: action.text },
        });
        emit({ type: 'content_block_stop', index: 0 });
        emit({
          type: 'message_delta',
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        emit({ type: 'message_stop' });
      } else {
        const output = tool
          ? {
              id: `fc-${action.id}`,
              type: 'function_call',
              call_id: action.id,
              name: action.tool,
              arguments: JSON.stringify(action.input),
            }
          : {
              id: `msg-${requests}`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: action.text, annotations: [] }],
              status: 'completed',
            };
        const response = {
          id: `resp-${requests}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: body.model,
          output: [output],
          usage: {
            input_tokens: 10,
            output_tokens: 8,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 0 },
          },
        };
        reply.setHeader('content-type', 'text/event-stream');
        emit({
          type: 'response.created',
          response: { ...response, output: [], status: 'in_progress' },
        });
        emit({ type: 'response.output_item.added', output_index: 0, item: output });
        emit({ type: 'response.output_item.done', output_index: 0, item: output });
        emit({ type: 'response.completed', response });
      }
      reply.end();
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Fixture failed.';
      if (!reply.headersSent) {
        reply.statusCode = 500;
        reply.setHeader('content-type', 'application/json');
      }
      reply.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'The local conformance fixture rejected this request.',
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    failure: () => failure,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
