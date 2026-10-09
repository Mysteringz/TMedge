/**
 * The training script editor: CodeMirror 6 in Python mode, as the design
 * hand-off asks ("use a real editor instead of the prototype's textarea
 * overlay"), dressed in the design's colours.
 *
 * CodeMirror writes its styles into a <style> element. The console's CSP has
 * no 'unsafe-inline', so the element carries the page's nonce (below).
 */
import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { styleTags, tags as t } from '@lezer/highlight';

const INDENT = '    ';

/** The whole decorator, "@" and name, in the design's decorator colour. */
const pythonWithDecorators = new LanguageSupport(
  pythonLanguage.configure({ props: [styleTags({ 'Decorator/VariableName Decorator/MemberExpression/PropertyName': t.meta })] }),
  python().support,
);

// Bluegrid's Gray 100 syntax colours, with keywords in the console's accent.
const colours = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.bool, t.null], color: 'var(--orange-40)' },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: '#82cfff' },
  { tag: [t.string, t.special(t.string)], color: '#3ddbd9' },
  { tag: t.number, color: '#ff7eb6' },
  { tag: t.meta, color: '#78a9ff' },
  { tag: t.self, color: 'var(--text-secondary)' },
  { tag: [t.comment, t.lineComment], color: 'var(--text-helper)', fontStyle: 'italic' },
]);

const ground = 'var(--background)';
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: ground, color: 'var(--text-secondary)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--orange-40)' },
  '.cm-line': { padding: '0 24px 0 6px' },
  '.cm-gutters': { backgroundColor: ground, color: 'var(--border-strong-01)', border: 'none', paddingLeft: '14px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 0', minWidth: '2ch' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-helper)' },
  '.cm-activeLine': { backgroundColor: 'rgba(141, 141, 141, .08)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--orange-40)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--orange-40) 28%, transparent)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--orange-40) 20%, transparent)', color: 'inherit' },
}, { dark: true });

/**
 * The nonce the edge put in this page (src/algo/server.ts sendShell): the
 * console's CSP admits CodeMirror's <style> element only with it. Absent
 * under the Vite dev server, which sends no CSP.
 */
const NONCE = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
const cspNonce = NONCE && !NONCE.startsWith('{{') ? [EditorView.cspNonce.of(NONCE)] : [];

/** Tab puts four spaces at the cursor (the design), or indents a selection. */
const tabKeys = keymap.of([{
  key: 'Tab',
  run: (v) => {
    if (v.state.readOnly) return false;
    if (v.state.selection.ranges.some((r) => !r.empty)) return indentMore(v);
    v.dispatch(v.state.replaceSelection(INDENT));
    return true;
  },
  shift: indentLess,
}]);

export interface CodeEditorProps {
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  language: 'python' | 'text';
  label: string;
}

export function CodeEditor({ value, onChange, readOnly = false, language, label }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const props = useRef({ onChange, readOnly, language });
  props.current = { onChange, readOnly, language };
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());

  /** A fresh state: a newly loaded file starts with an empty undo history. */
  const stateFor = (doc: string) => EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(),
      indentUnit.of(INDENT), EditorState.tabSize.of(4),
      tabKeys, keymap.of([...defaultKeymap, ...historyKeymap]),
      lang.current.of(props.current.language === 'python' ? pythonWithDecorators : []),
      ro.current.of(EditorState.readOnly.of(props.current.readOnly)),
      syntaxHighlighting(colours), theme, cspNonce,
      EditorView.contentAttributes.of({ 'aria-label': label }),
      EditorView.updateListener.of((u) => { if (u.docChanged) props.current.onChange?.(u.state.doc.toString()); }),
    ],
  });

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: stateFor(value) });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // Created once; the effects below keep it in step with its props.
  }, []);

  // Different text from outside (another job, another file): replace the
  // state, so undo cannot walk back into the previous file. setState is not
  // a transaction, so it is not echoed back through onChange.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.setState(stateFor(value));
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: [
      lang.current.reconfigure(language === 'python' ? pythonWithDecorators : []),
      ro.current.reconfigure(EditorState.readOnly.of(readOnly)),
    ] });
  }, [language, readOnly]);

  return <div ref={host} className={`cx-code ${readOnly ? 'is-ro' : ''}`} />;
}
