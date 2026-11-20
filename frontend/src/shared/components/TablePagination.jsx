import React, { Fragment, useEffect, useState } from 'react';

export function useTablePagination(total, defaultPageSize = 10) {
  const [requestedPage, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);

  useEffect(() => {
    setPage(previous => Math.min(previous, pageCount));
  }, [pageCount]);

  return { total, page, pageCount, pageSize, start, end, setPage,
    resetPage: () => setPage(1),
    changePageSize: size => { setPageSize(size); setPage(1); } };
}

function pageNumbers(page, count) {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const start = Math.max(2, Math.min(page - 1, count - 4));
  const end = Math.min(count - 1, Math.max(page + 1, 5));
  return [1, ...Array.from({ length: end - start + 1 }, (_, index) => start + index), count];
}

export default function TablePagination({ pagination, label, recordLabel = '' }) {
  const { total, page, pageCount, pageSize, start, end, setPage, changePageSize } = pagination;
  const numbers = pageNumbers(page, pageCount);
  return <div className="table-pagination">
    <div className="table-pagination-summary">
      <label>Rows per page <select value={pageSize} onChange={event => changePageSize(Number(event.target.value))}>
        {[10, 20, 50].map(size => <option key={size}>{size}</option>)}
      </select></label>
      <span aria-live="polite">{total ? 'Showing ' + (start + 1) + '\u2013' + end + ' of ' + total : 'Showing 0 of 0'}{recordLabel && ' ' + recordLabel}</span>
    </div>
    <nav aria-label={label}>
      <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span className="sr-only">Page {page} of {pageCount}</span>
      {numbers.map((number, index) => <Fragment key={number}>
        {index > 0 && number - numbers[index - 1] > 1 && <span aria-hidden="true">...</span>}
        <button type="button" aria-label={'Page ' + number} aria-current={page === number ? 'page' : undefined}
          onClick={() => setPage(number)}>{number}</button>
      </Fragment>)}
      <button type="button" disabled={page === pageCount} onClick={() => setPage(page + 1)}>Next</button>
    </nav>
  </div>;
}
