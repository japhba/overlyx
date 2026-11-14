/** The Recent · Name switch over a project's files (app/filesort.ts), on the start page and a project's page. */
import type { FileSort } from './filesort';
import './filesort.css';

export function FileSortSwitch({ sort, onSort }: { sort: FileSort; onSort: (s: FileSort) => void }) {
  return (
    <span class="hfs" data-file-sort={sort} title="The order of each project's files">
      Files
      <span class="hfs-pair" role="radiogroup" aria-label="Order of the files">
        <button type="button" role="radio" aria-checked={sort === 'recent'} class={sort === 'recent' ? 'on' : ''} data-file-sort-choice="recent" title="Most recently changed or opened first" onClick={() => onSort('recent')}>Recent</button>
        <button type="button" role="radio" aria-checked={sort === 'name'} class={sort === 'name' ? 'on' : ''} data-file-sort-choice="name" title="The main document first, then by name" onClick={() => onSort('name')}>Name</button>
      </span>
    </span>
  );
}
