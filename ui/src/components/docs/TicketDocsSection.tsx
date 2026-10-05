import { useTicketDocs } from '../../api/docs';
import styles from './TicketDocsSection.module.css';

interface TicketDocsSectionProps {
  ticketId: string;
  onOpenPage: (pageId: string, projectId: string) => void;
}

export function TicketDocsSection({ ticketId, onOpenPage }: TicketDocsSectionProps) {
  const { data } = useTicketDocs(ticketId);
  if (!data || data.length === 0) return null;

  return (
    <div className={styles.section}>
      <span className={styles.label}>Linked docs</span>
      <div className={styles.card}>
        {data.map((doc) => (
          <button
            key={`${doc.pageId}-${doc.section ?? ''}`}
            type="button"
            className={styles.row}
            onClick={() => onOpenPage(doc.pageId, doc.projectId)}
          >
            <span className={styles.main}>
              <span className={styles.titleLine}>
                <span className={styles.title}>{doc.title}</span>
                {doc.section && <span className={styles.sectionName}>› {doc.section}</span>}
              </span>
              {doc.snippet && <span className={styles.snippet}>{doc.snippet}</span>}
            </span>
            <span className={styles.pill}>From docs</span>
          </button>
        ))}
      </div>
    </div>
  );
}
