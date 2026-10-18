import { useEffect, useState } from 'react';
import type { WorkspaceMode } from '../../shared/types';
import { receiptMarkdown, type PublicReceipt } from '../../shared/public-receipt';
import { request } from '../api';
import { Dialog, FormError } from './primitives';

export function ShareReceiptDialog({
  workId,
  mode,
  onClose,
}: {
  workId: string;
  mode: WorkspaceMode;
  onClose: () => void;
}) {
  const [receipt, setReceipt] = useState<PublicReceipt | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    setReceipt(null);
    setError('');
    void request<PublicReceipt>(`/work/${workId}/public-receipt`, mode)
      .then((value) => {
        if (current) setReceipt(value);
      })
      .catch((cause) => {
        if (current) setError((cause as Error).message);
      });
    return () => {
      current = false;
    };
  }, [workId, mode]);
  const markdown = receipt ? receiptMarkdown(receipt) : '';
  function download(json: boolean) {
    if (!receipt) return;
    const extension = json ? 'json' : 'md';
    const prefix = receipt.evidence === 'fictional-demo' ? 'forge-demo' : 'forge-work';
    const url = URL.createObjectURL(
      new Blob([json ? JSON.stringify(receipt, null, 2) : markdown], {
        type: json ? 'application/json' : 'text/markdown;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prefix}-receipt.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog title="Share work receipt" subtitle="REVIEW BEFORE SHARING" onClose={onClose}>
      <div className="dialog-body form-stack">
        <p>
          Share harness order, attempt counts, reported tokens and USD estimates. Work titles,
          projects, prompts, memory, file paths, accounts and identifiers are excluded.
        </p>
        {receipt?.evidence === 'fictional-demo' && (
          <p className="source-note">Fictional demo. The exported receipt retains this label.</p>
        )}
        {receipt ? (
          <pre
            className="receipt-preview"
            role="region"
            tabIndex={0}
            aria-label="Public receipt preview"
          >
            {markdown}
          </pre>
        ) : (
          !error && <p role="status">Preparing the public fields.</p>
        )}
        <p className="source-note">
          This is a snapshot of local records, not independent proof of artifact correctness,
          lossless native-state transfer or provider charges. Review the complete preview. Nothing
          is uploaded or published by Forge.
        </p>
        <FormError error={error} />
        {copied && <p role="status">Receipt copied.</p>}
      </div>
      <footer className="sheet-footer">
        <button className="button secondary" disabled={!receipt} onClick={() => download(true)}>
          Download JSON
        </button>
        <button className="button secondary" disabled={!receipt} onClick={() => download(false)}>
          Download Markdown
        </button>
        <button
          className="button primary"
          disabled={!receipt}
          onClick={() => {
            setError('');
            if (!navigator.clipboard) {
              setError('Clipboard is unavailable. Use Download Markdown.');
              return;
            }
            void navigator.clipboard
              .writeText(markdown)
              .then(() => setCopied(true))
              .catch(() => setError('Clipboard is unavailable. Use Download Markdown.'));
          }}
        >
          Copy receipt
        </button>
      </footer>
    </Dialog>
  );
}
