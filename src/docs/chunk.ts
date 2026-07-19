export interface DocChunk {
  id: string;
  heading: string;
  content: string;
  offset: number;
}

const MAX_CHUNK_SIZE = 1200;
const OVERLAP = 150;

/**
 * Split a document into chunks along markdown headings when present, then
 * hard-wrap any section still over MAX_CHUNK_SIZE with a sliding overlap so
 * BM25 scores individual passages instead of whole (often huge) files.
 */
export function chunkDocument(docName: string, content: string): DocChunk[] {
  const sections = splitByHeadings(content);
  const chunks: DocChunk[] = [];
  let index = 0;
  for (const section of sections) {
    if (section.content.length <= MAX_CHUNK_SIZE) {
      chunks.push({
        id: `${docName}#${index}`,
        heading: section.heading,
        content: section.content,
        offset: section.offset,
      });
      index++;
      continue;
    }
    let start = 0;
    while (start < section.content.length) {
      const end = Math.min(start + MAX_CHUNK_SIZE, section.content.length);
      chunks.push({
        id: `${docName}#${index}`,
        heading: section.heading,
        content: section.content.slice(start, end),
        offset: section.offset + start,
      });
      index++;
      if (end >= section.content.length) break;
      start = end - OVERLAP;
    }
  }
  return chunks;
}

interface Section {
  heading: string;
  content: string;
  offset: number;
}

function splitByHeadings(content: string): Section[] {
  const headingRe = /^#{1,6}\s+.+$/gm;
  const matches = [...content.matchAll(headingRe)];
  if (matches.length === 0) return [{ heading: "", content, offset: 0 }];

  const sections: Section[] = [];
  const first = matches[0];
  if (first.index! > 0) {
    const lead = content.slice(0, first.index).trim();
    if (lead) sections.push({ heading: "", content: lead, offset: 0 });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    const heading = matches[i][0].replace(/^#{1,6}\s+/, "").trim();
    sections.push({ heading, content: content.slice(start, end).trim(), offset: start });
  }
  return sections;
}
