import { render } from 'preact';
import { App } from './app/App';
import './styles.css';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

render(<App />, document.getElementById('app')!);
