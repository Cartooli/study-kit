import { strToU8, zipSync } from 'fflate';

export const docx = (bodyXml: string) =>
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${bodyXml}</w:body></w:document>`),
  });

export const para = (text: string, style?: string, numbered = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numbered ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export const pptx = (slides: { title: string; body: string[] }[]) =>
  zipSync(
    Object.fromEntries(
      slides.map((s, i) => [
        `ppt/slides/slide${i + 1}.xml`,
        strToU8(
          `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${s.title}</a:t></a:r></a:p></p:txBody></p:sp>` +
            `<p:sp><p:txBody>${s.body.map(b => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        ),
      ]),
    ),
  );

// Minimal text PDF (Helvetica, one text object per page) with a correct xref table.
export function pdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const esc = (s: string) => s.replace(/[\\()]/g, m => '\\' + m);
    const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
