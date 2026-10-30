import { useState } from 'react';
import { StatePanel } from './StatePanel';
import { isVideoName } from './kinds';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

/** Audio and video in a normal player. */
export function MediaReader({ item, actions }: ReaderProps) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <StatePanel tone="error" title="Could not make a preview" actions={actions}>
        The file may be damaged or your system cannot play this format. Nothing was changed.
      </StatePanel>
    );
  return (
    <div className={styles.mediaReader}>
      {isVideoName(item.name) ? (
        <video
          key={item.src}
          src={item.src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          aria-label={item.name}
        />
      ) : (
        <audio
          key={item.src}
          src={item.src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          aria-label={item.name}
        />
      )}
    </div>
  );
}
