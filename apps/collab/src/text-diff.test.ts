import { FILE_TEXT_NAME } from '@integris/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyText, mergeText } from './text-diff.js';

const docWith = (text: string) => {
  const doc = new Y.Doc();
  doc.getText(FILE_TEXT_NAME).insert(0, text);
  return doc;
};
const textOf = (doc: Y.Doc) => doc.getText(FILE_TEXT_NAME).toString();

describe('applyText', () => {
  it('changes only what differs', () => {
    const doc = docWith('\\section{Intro}\nTexte.');
    const changes: number[] = [];
    doc.on('update', (update: Uint8Array) => changes.push(update.length));
    applyText(doc.getText(FILE_TEXT_NAME), '\\section{Introduction}\nTexte.', null);
    expect(textOf(doc)).toBe('\\section{Introduction}\nTexte.');
    expect(changes).toHaveLength(1);
    applyText(doc.getText(FILE_TEXT_NAME), '\\section{Introduction}\nTexte.', null);
    expect(changes).toHaveLength(1);
  });
});

describe('mergeText', () => {
  it('keeps the edits made since the base, without duplicating text', () => {
    const server = docWith('\\title{A}\nChapitre 1.\n');
    const base = Y.encodeStateAsUpdate(server);
    // A client offline since the base keeps typing.
    const offline = new Y.Doc();
    Y.applyUpdate(offline, base);
    offline.getText(FILE_TEXT_NAME).insert(21, ' Suite.');
    // Meanwhile the file is restored to another text.
    const next = mergeText(server, base, '\\title{Mémoire}\nChapitre 1.\n', null);
    // The client comes back.
    Y.applyUpdate(server, Y.encodeStateAsUpdate(offline));
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(server));
    expect(textOf(server)).toBe('\\title{Mémoire}\nChapitre 1. Suite.\n');
    expect(textOf(offline)).toBe(textOf(server));
    // The new base holds exactly the replacement.
    const check = new Y.Doc();
    Y.applyUpdate(check, next);
    expect(textOf(check)).toBe('\\title{Mémoire}\nChapitre 1.\n');
  });

  it('applies the replacement over edits already in the document', () => {
    const server = docWith('Hello');
    const base = Y.encodeStateAsUpdate(server);
    server.getText(FILE_TEXT_NAME).insert(0, 'A');
    mergeText(server, base, 'Hello there', null);
    expect(textOf(server)).toBe('AHello there');
  });
});
