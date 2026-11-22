// The editor, browser bridge and Quick Look all load this bundle first.
// Marked and Mermaid call these APIs on macOS 12's original JavaScriptCore.
import 'core-js/stable/array/at.js';
import 'core-js/stable/string/at.js';
import 'core-js/stable/object/has-own.js';
import 'core-js/stable/structured-clone.js';

export {Schema} from 'prosemirror-model';
export {EditorView, Decoration, DecorationSet} from 'prosemirror-view';
export {EditorState, TextSelection, Selection, Plugin} from 'prosemirror-state';
export {keymap} from 'prosemirror-keymap';
export {InputRule, inputRules, wrappingInputRule, textblockTypeInputRule, undoInputRule} from 'prosemirror-inputrules';
export {chainCommands, baseKeymap, toggleMark, setBlockType, wrapIn, exitCode} from 'prosemirror-commands';
export {wrapInList, splitListItem, liftListItem, sinkListItem} from 'prosemirror-schema-list';
export {undo, redo, history, closeHistory} from 'prosemirror-history';
export {tableEditing, tableNodes, goToNextCell, addRowAfter, addColumnAfter, deleteRow, deleteColumn} from 'prosemirror-tables';
export {marked} from 'marked';
export {default as markedCjkFriendly} from 'marked-cjk-friendly';
export {default as katex} from 'katex';
export {default as hljs} from 'highlight.js';
