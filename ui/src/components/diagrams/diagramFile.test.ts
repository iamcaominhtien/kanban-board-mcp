import { describe, expect, it } from 'vitest';
import { DiagramFileError, readDiagramFile } from './diagramFile';

const file = (text: string, name: string) => new File([text], name);

describe('readDiagramFile', () => {
  it('reads the XML kept in the content attribute of a draw.io SVG', async () => {
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;&lt;diagram name=&quot;A&quot;/&gt;&lt;/mxfile&gt;"></svg>`;
    expect(await readDiagramFile(file(svg, 'a.svg'))).toBe('<mxfile><diagram name="A"/></mxfile>');
  });

  it('rejects an SVG without draw.io data', async () => {
    await expect(readDiagramFile(file('<svg></svg>', 'a.svg'))).rejects.toBeInstanceOf(DiagramFileError);
  });

  it('passes plain draw.io XML through', async () => {
    expect(await readDiagramFile(file('<mxfile></mxfile>', 'a.drawio'))).toBe('<mxfile></mxfile>');
  });
});
