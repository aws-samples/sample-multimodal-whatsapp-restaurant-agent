// Unit tests for the pure order-lifecycle logic (Task 27 kitchen sim + notifier).
import { nextStatus, isNotifiableTransition, STAGE_AT_MS } from '../lambda/lifecycle';

describe('nextStatus (kitchen simulator transition, one step per scan)', () => {
  test('confirmed advances to in-preparation only at/after 1 min', () => {
    expect(nextStatus('confirmed', 0)).toBeNull();
    expect(nextStatus('confirmed', STAGE_AT_MS.inPreparation - 1)).toBeNull();
    expect(nextStatus('confirmed', STAGE_AT_MS.inPreparation)).toBe('in-preparation');
    expect(nextStatus('confirmed', 10 * 60_000)).toBe('in-preparation'); // stale: still one step
  });

  test('in-preparation advances to ready only at/after 2 min', () => {
    expect(nextStatus('in-preparation', STAGE_AT_MS.ready - 1)).toBeNull();
    expect(nextStatus('in-preparation', STAGE_AT_MS.ready)).toBe('ready');
  });

  test('terminal/unknown statuses never advance', () => {
    expect(nextStatus('ready', 10 * 60_000)).toBeNull();
    expect(nextStatus('completed', 10 * 60_000)).toBeNull();
    expect(nextStatus('received', 10 * 60_000)).toBeNull();
    expect(nextStatus('bogus', 10 * 60_000)).toBeNull();
  });
});

describe('isNotifiableTransition (notifier stream decision)', () => {
  test('fires only on a real change into a notify-worthy status', () => {
    expect(isNotifiableTransition('confirmed', 'in-preparation')).toBe(true);
    expect(isNotifiableTransition('in-preparation', 'ready')).toBe(true);
  });

  test('no-op when status is unchanged', () => {
    expect(isNotifiableTransition('in-preparation', 'in-preparation')).toBe(false);
    expect(isNotifiableTransition('ready', 'ready')).toBe(false);
  });

  test('does not fire for non-notify statuses', () => {
    expect(isNotifiableTransition('confirmed', 'confirmed')).toBe(false);
    expect(isNotifiableTransition('ready', 'completed')).toBe(false); // completed is not notified
    expect(isNotifiableTransition(undefined, 'received')).toBe(false);
    expect(isNotifiableTransition('confirmed', undefined)).toBe(false);
  });
});
