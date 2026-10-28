import { useState } from 'react';
import { diagramDownloadUrl, diagramSvgUrl } from '../../api/diagrams';
import { DiagramIcon } from './DiagramIcon';
import { useToast } from '../Toast';
import { fileStem, saveBlob, svgToPng } from './diagramFile';
import styles from './Diagrams.module.css';

interface Props {
  id: string;
  label: string;
  version?: number;
  className?: string;
  /** Close the menu after an action. */
  onDone: () => void;
}

async function fetchSvg(id: string, version?: number): Promise<string> {
  const res = await fetch(diagramSvgUrl(id, version));
  if (!res.ok) throw new Error('Could not load the diagram');
  return res.text();
}

/**
 * The Download menu of a diagram: .drawio, SVG, PNG 2x and copy as image.
 * @param props.id - Diagram id.
 * @param props.label - Diagram label (file name).
 * @param props.version - Pinned version to download; latest by default.
 * @param props.onDone - Called after an action so the host can close the menu.
 */
export function DiagramMenu({ id, label, version, className, onDone }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function png() {
    setBusy(true);
    try {
      saveBlob(await svgToPng(await fetchSvg(id, version)), `${fileStem(label)}.png`);
    } catch {
      toast.error("Couldn't make the PNG", 'Download the SVG instead.');
    } finally {
      setBusy(false);
      onDone();
    }
  }

  async function copy() {
    setBusy(true);
    try {
      const blob = await svgToPng(await fetchSvg(id, version));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied as image');
    } catch {
      toast.error("Couldn't copy the image", 'Your browser may block copying images. Download the PNG instead.');
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className={className ?? styles.menu} role="menu" aria-label="Download">
      <div className={styles.menuHead}>DOWNLOAD</div>
      <a
        className={styles.menuItem}
        role="menuitem"
        href={diagramDownloadUrl(id, 'drawio', version)}
        download
        onClick={onDone}
        style={{ textDecoration: 'none' }}
      >
        <DiagramIcon name="file" /> Editable file <span className={styles.menuExt}>.drawio</span>
      </a>
      <a
        className={styles.menuItem}
        role="menuitem"
        href={diagramDownloadUrl(id, 'svg', version)}
        download
        onClick={onDone}
        style={{ textDecoration: 'none' }}
      >
        <DiagramIcon name="image" /> Vector image <span className={styles.menuExt}>.svg</span>
      </a>
      <button type="button" role="menuitem" className={styles.menuItem} disabled={busy} onClick={() => void png()}>
        <DiagramIcon name="image" /> Image, 2× <span className={styles.menuExt}>.png</span>
      </button>
      <div className={styles.menuSep} />
      <button type="button" role="menuitem" className={styles.menuItem} disabled={busy} onClick={() => void copy()}>
        <DiagramIcon name="copy" /> Copy as image
      </button>
    </div>
  );
}
