/**
 * The four-step tour of what is new in the editor (design "Starting and shaping a page", frames 39-43): colours and
 * highlights, pictures that text wraps around, embeds that start with a slash, page settings and templates. It shows
 * once per person (kept on this device), the first time they edit a page converted to the new format; Skip tour is
 * always there. On a phone the card sits at the bottom with the page dimmed behind it.
 */

import { useEffect, useState } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import './start.css';

const SEEN_KEY = 'docsWhatsNewTourSeen';

/** The steps, in order. */
export const TOUR_STEPS: readonly { title: string; text: string; phoneText?: string }[] = [
  {
    title: 'Colour your words',
    text: 'Pick a text colour or a highlight from the page palette. Tables and backgrounds use the same colours.',
  },
  {
    title: 'Pictures that text wraps around',
    text: 'Choose left or right in a picture’s toolbar, or drag it to an edge. On a phone it stacks above the text.',
    phoneText: 'Choose left or right in a picture’s toolbar. On a phone it stacks above the text.',
  },
  {
    title: 'Embeds start with a slash',
    text: 'Type / and a word: video, HTML, diagram, file, sketch or canvas. The list narrows as you type.',
  },
  {
    title: 'Set up the whole page',
    text: 'Width, fonts, colours and a cover live in Page settings. Save a page you like as a template.',
  },
];

/** True once this person finished or skipped the tour on this device. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked: never nag
  }
}

/** Remembers that the tour was seen. */
export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

/** Forgets that the tour was seen ("What's new" replays it). */
export function resetTour(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* storage blocked */
  }
}

/**
 * The tour, when it has not been seen yet.
 * @param props.layout - Phone: a bottom card over a dimmed page; otherwise a card in the corner.
 * @param props.onClose - Called after Skip tour or Done.
 */
export function WhatsNewTour({ layout = 'desktop', onClose }: { layout?: DocsLayout; onClose?: () => void }) {
  const [open, setOpen] = useState(() => !tourSeen());
  const [step, setStep] = useState(0);
  const phone = layout === 'phone';
  const close = () => {
    markTourSeen();
    setOpen(false);
    onClose?.();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!open) return null;
  const s = TOUR_STEPS[step];
  const last = step === TOUR_STEPS.length - 1;
  return (
    <>
      {phone && <div className="dk-tour-scrim" aria-hidden="true" onClick={close} />}
      <div
        className={`dk-tour docs-root${phone ? ' dk-tour-phone' : ''}`}
        role="dialog"
        aria-label="What is new"
        data-testid="whats-new-tour"
      >
        <div className="dk-tour-step">
          NEW · {step + 1} OF {TOUR_STEPS.length}
        </div>
        <h2>{s.title}</h2>
        <p>{phone && s.phoneText ? s.phoneText : s.text}</p>
        <div className="dk-tour-foot">
          <button type="button" className="dk-tour-skip" onClick={close}>
            Skip tour
          </button>
          <span className="dk-tour-dots" aria-hidden="true">
            {TOUR_STEPS.map((_, i) => (
              <span key={i} data-on={i === step} />
            ))}
          </span>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={() => (last ? close() : setStep(step + 1))}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}
