const arrow = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#9AA8A0"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0, alignSelf: 'center' }}
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const step = (title: string, body: string, blue: boolean) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      border: `1px solid ${blue ? '#CBDDEE' : '#CFE3D6'}`,
      borderRadius: 10,
      background: blue ? '#F2F7FC' : '#F3F9F5',
      padding: '12px 14px',
    }}
  >
    <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
    <div style={{ fontSize: 12, lineHeight: 1.5, color: '#3A4A3E', marginTop: 4 }}>{body}</div>
  </div>
);

const card = (bg: string) => ({
  padding: '18px 20px',
  border: '1px solid #E3E8E5',
  borderRadius: 12,
  background: bg,
});
const ul = { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55, color: '#3A4A3E' } as const;
const li = { margin: '0 0 6px' } as const;
const h = { fontSize: 14, fontWeight: 700, color: '#1E2A22', marginBottom: 10 } as const;

/** The right-hand cards of the knowledge base (design/screens/ai-board-wave3.md, I). */
export function KbExplainer() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="kb-explainer">
      <div
        className="ai-card"
        style={{ background: '#FBFCFB', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}
      >
        <div style={{ fontSize: 13, fontWeight: 700 }}>How an AI actually finds something</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
          {step(
            'Table of contents',
            'One line per document. It reads this first, and often that is enough to know which file it wants.',
            true,
          )}
          {arrow}
          {step(
            'Keyword search',
            'BM25 over the text, the summaries and the keywords. It tries more than one wording, the way it does with code.',
            false,
          )}
          {arrow}
          {step('Read', 'It opens the part it needs, not the whole file.', false)}
        </div>
        <div className="ai-hint" style={{ fontSize: 11.5 }}>
          Three MCP tools: <span className="ai-mono">knowledge_index</span>,{' '}
          <span className="ai-mono">knowledge_search</span>, <span className="ai-mono">knowledge_read</span>. Results
          say which store they came from.
        </div>
      </div>
      <div style={card('#FFFBEF')} data-testid="kb-who-sees">
        <div style={h}>Who sees it, and what it is allowed to say</div>
        <ul style={ul}>
          <li style={li}>
            <b>A document is only as visible as its source.</b> A Docs page that is private stays private: it is indexed
            for the people and AIs that could already open it, and never becomes reachable through the shared store.
          </li>
          <li style={li}>
            <b>The shared store is for things meant to be shared</b> — company conventions, a security review. Adding a
            project document to it is a deliberate move and says who will be able to read it.
          </li>
          <li style={li}>
            <b>An uploaded file is untrusted input.</b> Its text is fenced and labelled with its source before any AI
            reads it, so a line inside a PDF cannot act as an instruction.
          </li>
          <li style={li}>
            Permissions are still enforced outside the model: a document cannot widen what an AI is allowed to do,
            whatever it says.
          </li>
        </ul>
      </div>
      <div style={card('#F6FAF7')}>
        <div style={h}>Why not embeddings</div>
        <ul style={ul}>
          <li style={li}>
            Documents do not go to an embedding service, and a local model is slow enough to be felt on every lookup.
          </li>
          <li style={li}>
            Claude reads these documents anyway when it works, so sending them to one more service buys nothing and adds
            a key.
          </li>
          <li style={li}>
            For a store this size, a table of contents plus BM25 is what a person would do, and it is explainable when
            it goes wrong.
          </li>
          <li style={li}>
            <b>It stays an option.</b> If a store grows past what keyword search can handle, embeddings become a switch
            — not a rewrite.
          </li>
        </ul>
      </div>
    </div>
  );
}
