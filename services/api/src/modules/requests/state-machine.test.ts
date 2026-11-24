import { describe, expect, it } from 'vitest';
import { REQUEST_STATUSES } from '../../db/schema/enums.js';
import { assertTransition, canTransition, eventFor, PRE_SEND_STATUSES, type RequestStatus } from './state-machine.js';

describe('state machine', () => {
  it('allows the Phase 1 path and the edit loop', () => {
    expect(canTransition('drafted', 'approved')).toBe(true);
    expect(canTransition('approved', 'sent')).toBe(true);
    expect(canTransition('approved', 'drafted')).toBe(true); // an edit after approval
    expect(canTransition('drafted', 'closed')).toBe(true);
    expect(canTransition('approved', 'closed')).toBe(true);
  });

  it('never reaches sent from before sending except through approved', () => {
    // A request that has already been sent can return to "sent" (the person steps back to "no answer yet"). Nothing
    // that has not been sent can: only an approved draft leads to sent. The database trigger enforces the same.
    for (const from of ['drafted', 'closed', 'bounced'] as RequestStatus[]) {
      expect(canTransition(from, 'sent'), `${from} -> sent`).toBe(false);
    }
    expect(canTransition('approved', 'sent')).toBe(true);
  });

  it('does not let a sent request go back, be edited or be closed directly', () => {
    for (const to of ['drafted', 'approved', 'closed'] as RequestStatus[]) expect(canTransition('sent', to), `sent -> ${to}`).toBe(false);
  });

  it('after sending: a reply may be received, an outcome set (also with no reply seen), or the request found unanswered or bounced', () => {
    for (const to of ['reply_received', 'replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply', 'bounced'] as RequestStatus[]) {
      expect(canTransition('sent', to), `sent -> ${to}`).toBe(true);
    }
    for (const from of ['replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply'] as RequestStatus[]) {
      expect(canTransition(from, 'closed'), `${from} -> closed`).toBe(true);
    }
  });

  it('lets the person set, change and take back an outcome, but a status is never the same as the one it leaves', () => {
    const tracking: RequestStatus[] = ['sent', 'reply_received', 'no_reply', 'replied_deleted', 'replied_info_requested', 'replied_refused'];
    for (const from of tracking) {
      for (const to of tracking) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(from !== to);
      }
    }
  });

  it('closes only an answered or unanswered request: not one that is merely sent or has a reply with no outcome', () => {
    expect(canTransition('sent', 'closed')).toBe(false);
    expect(canTransition('reply_received', 'closed')).toBe(false);
  });

  it('never moves a request back before sending, and never into bounced except from sent', () => {
    for (const from of ['reply_received', 'no_reply', 'replied_deleted', 'replied_info_requested', 'replied_refused'] as RequestStatus[]) {
      for (const to of ['drafted', 'approved', 'bounced'] as RequestStatus[]) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it('treats closed and bounced as final', () => {
    for (const to of REQUEST_STATUSES) {
      expect(canTransition('closed', to)).toBe(false);
      expect(canTransition('bounced', to)).toBe(false);
    }
  });

  it('has no self transitions', () => {
    for (const s of REQUEST_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('records each transition as the right event type', () => {
    expect(eventFor('drafted', 'approved')).toBe('approved');
    expect(eventFor('approved', 'drafted')).toBe('edited');
    expect(eventFor('approved', 'sent')).toBe('sent');
    expect(eventFor('drafted', 'closed')).toBe('closed');
    expect(eventFor('sent', 'bounced')).toBe('bounced');
    expect(eventFor('sent', 'reply_received')).toBe('reply_received');
    expect(eventFor('reply_received', 'replied_deleted')).toBe('outcome_set');
    expect(eventFor('sent', 'replied_refused')).toBe('outcome_set');
    expect(eventFor('replied_refused', 'sent')).toBe('outcome_set'); // back to no answer yet
    expect(eventFor('sent', 'no_reply')).toBe('reply_label');
  });

  it('assertTransition throws a 409 with a stable code', () => {
    expect(() => assertTransition('drafted', 'sent')).toThrowError(expect.objectContaining({ status: 409, code: 'invalid_transition' }));
    expect(() => assertTransition('drafted', 'approved')).not.toThrow();
  });

  it('knows which states are still editable', () => {
    expect([...PRE_SEND_STATUSES]).toEqual(['drafted', 'approved']);
  });
});
