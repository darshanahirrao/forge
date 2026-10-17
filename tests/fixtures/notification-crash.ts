import { dirname } from 'node:path';
import { Store } from '../../server/store.js';
import { Notifications } from '../../server/notifications.js';

const store = new Store(process.argv[2]);
const notifications = new Notifications(
  store,
  dirname(process.argv[2]),
  'https://forge.fixture.invalid',
  { timeoutMs: 15000 },
);
await notifications.configure({
  expectedRevision: 0,
  serverOrigin: process.argv[3],
  topic: 'owned-crash-fixture',
  kinds: ['approval'],
});
notifications.test();
await notifications.idle();
await notifications.close();
store.close();
