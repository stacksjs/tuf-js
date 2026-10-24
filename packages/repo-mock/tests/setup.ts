import nock from 'nock';

// Built-in HTTP modules survive Jest environments reused in the same worker.
// Restore Nock before that environment is disposed, so the next one owns its hooks.
afterAll(() => {
  nock.abortPendingRequests();
  nock.cleanAll();
  nock.restore();
});
