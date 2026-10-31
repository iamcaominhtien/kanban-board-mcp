import type { AiAccount } from '../../../types/aiAccounts';
import { AccountDialog } from './AccountParts';

/** “See members using it”: the AI members that run as the account, in this project and in other projects. */
export function AccountMembersDialog({ account, onClose }: { account: AiAccount; onClose: () => void }) {
  const rows = [
    ...account.membersHere.map((m) => ({ ...m, where: 'This project' })),
    ...account.membersElsewhere.map((m) => ({ ...m, where: 'Another project' })),
  ];
  return (
    <AccountDialog
      title={`Members using ${account.name}`}
      narrow
      onClose={onClose}
      body={
        rows.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <b style={{ flex: 1 }}>{m.name}</b>
                <span className="acc-hint">{m.where}</span>
              </div>
            ))}
            {rows.length > 1 && (
              <div className="acc-hint" style={{ marginTop: 6 }}>
                {rows.length} members share this account and its limits.
              </div>
            )}
          </div>
        ) : (
          <div>No AI member uses it.</div>
        )
      }
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Close
          </button>
        </>
      }
    />
  );
}
