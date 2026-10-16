#!/usr/bin/env node
// Native stream-json transport fixture. No model request, shell command, or file write occurs.
const readline = require('node:readline');
const session_id = 'bdebe950-86e6-4813-95f8-400424283fd7';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          commands: [],
          models: [],
          account: { apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
        },
      },
    });
  } else if (message.type === 'user') {
    send({
      type: 'system',
      subtype: 'init',
      session_id,
      permissionMode: 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      cwd: process.cwd(),
      tools: ['Bash'],
      mcp_servers: [],
      model: 'synthetic',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      claude_code_version: 'synthetic',
    });
    send({
      type: 'control_request',
      request_id: 'native-sdk-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'synthetic transport fixture' },
        tool_use_id: 'native-sdk-tool',
        decision_reason: 'Synthetic permission transport test.',
      },
    });
  } else if (
    message.type === 'control_response' &&
    message.response.request_id === 'native-sdk-request'
  ) {
    const result = message.response.response;
    if (result?.behavior !== 'allow' || result.updatedPermissions) process.exit(2);
    send({
      type: 'result',
      subtype: 'success',
      session_id,
      uuid: 'b65f5970-1115-4dc7-b82f-c13c0bc2115f',
      is_error: false,
      result: 'Native SDK transport fixture completed.',
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 0,
      total_cost_usd: 0.01,
      usage: { input_tokens: 7, output_tokens: 3 },
      modelUsage: {
        synthetic: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 100000,
          maxOutputTokens: 1000,
          costBasis: 'list',
        },
      },
      permission_denials: [],
    });
  }
});
process.stdin.on('end', () => process.exit(0));
