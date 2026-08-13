import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  describeSmtpError,
  describeTransportError,
  type FailureDescriptor,
} from './failure-classification.js';

describe('classifyFailure — precedence (#2312 AC2)', () => {
  it('lets an SMTP reply code outrank a structural error code', () => {
    // Nodemailer sets both; the reply code is the server's own verdict.
    expect(classifyFailure({ smtpReplyCode: 421, errorCode: 'EAUTH' })).toEqual({
      terminal: false,
      reason: expect.any(String),
    });
  });

  it('lets an HTTP status outrank a structural error code', () => {
    expect(classifyFailure({ httpStatus: 503, errorCode: 'ETLS' }).terminal).toBe(false);
  });

  it('lets an SMTP reply code outrank an HTTP status', () => {
    expect(classifyFailure({ smtpReplyCode: 554, httpStatus: 503 }).terminal).toBe(true);
  });
});

describe('classifyFailure — SMTP reply codes (#2312 AC2)', () => {
  it.each([
    [554, true],
    [550, true],
    [535, true],
    [421, false],
    [450, false],
  ])('classifies %i as terminal=%s', (code, terminal) => {
    expect(classifyFailure({ smtpReplyCode: code }).terminal).toBe(terminal);
  });

  it('names authentication in operator language for 535', () => {
    expect(classifyFailure({ smtpReplyCode: 535 }).reason).toBe('authentication rejected — check credentials');
  });

  it('names the address rejection in operator language for 554', () => {
    expect(classifyFailure({ smtpReplyCode: 554 }).reason)
      .toBe('the mail server rejected the recipient or sender address');
  });

  it('falls back to a permanent-rejection reason for an unlisted 5xx', () => {
    expect(classifyFailure({ smtpReplyCode: 552 })).toEqual({
      terminal: true,
      reason: 'the mail server permanently rejected the message',
    });
  });

  it('treats a non-4xx/5xx reply code as transient rather than guessing', () => {
    expect(classifyFailure({ smtpReplyCode: 250 }).terminal).toBe(false);
  });
});

describe('classifyFailure — HTTP statuses (#2312 AC2)', () => {
  it.each([
    [401, true],
    [403, true],
    [404, true],
    [400, true],
    [408, false],
    [429, false],
    [503, false],
    [500, false],
  ])('classifies %i as terminal=%s', (status, terminal) => {
    expect(classifyFailure({ httpStatus: status }).terminal).toBe(terminal);
  });

  it('names authentication in operator language for 401', () => {
    expect(classifyFailure({ httpStatus: 401 }).reason).toBe('authentication rejected — check credentials');
  });

  it('names a plain rejection for other 4xx', () => {
    expect(classifyFailure({ httpStatus: 400 }).reason).toBe('the server rejected the request');
  });
});

describe('classifyFailure — structural error codes (#2312 AC3/AC5)', () => {
  it.each([
    ['EAUTH', 'authentication rejected — check credentials'],
    ['ENOAUTH', 'authentication rejected — check credentials'],
    ['EOAUTH2', 'authentication rejected — check credentials'],
    ['ETLS', "TLS/certificate rejected — check the TLS setting and the server's certificate"],
    ['EREQUIRETLS', "TLS/certificate rejected — check the TLS setting and the server's certificate"],
    ['EENVELOPE', 'sender or recipient address rejected'],
    ['EMESSAGE', 'the server rejected the message itself'],
    ['ECONFIG', 'misconfiguration — check the notifier settings'],
    ['EFILEACCESS', 'misconfiguration — check the notifier settings'],
    ['EURLACCESS', 'misconfiguration — check the notifier settings'],
  ])('classifies %s as terminal with its operator reason', (errorCode, reason) => {
    expect(classifyFailure({ errorCode })).toEqual({ terminal: true, reason });
  });

  it.each(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])(
    'classifies %s as transient',
    (errorCode) => {
      expect(classifyFailure({ errorCode }).terminal).toBe(false);
    },
  );
});

describe('classifyFailure — the transient default (#2312 AC5)', () => {
  it('classifies an unlisted error code as transient', () => {
    expect(classifyFailure({ errorCode: 'EWHATEVER' }).terminal).toBe(false);
  });

  it('classifies a descriptor with every field absent as transient', () => {
    expect(classifyFailure({}).terminal).toBe(false);
  });

  it('classifies a missing descriptor as transient', () => {
    expect(classifyFailure(undefined).terminal).toBe(false);
  });

  it('classifies a script non-zero exit as transient', () => {
    expect(classifyFailure({ exitCode: 3 }).terminal).toBe(false);
  });

  it('classifies a script timeout kill as transient', () => {
    expect(classifyFailure({ exitCode: null, killed: true }).terminal).toBe(false);
  });

  it('degrades a malformed descriptor to transient rather than rejecting it', () => {
    const malformed = { httpStatus: 'four-oh-one', smtpReplyCode: {} } as unknown as FailureDescriptor;
    expect(classifyFailure(malformed)).toEqual({ terminal: false, reason: expect.any(String) });
  });
});

describe('describeTransportError (#2312 AC4)', () => {
  it('reads a structural code off the error itself', () => {
    expect(describeTransportError(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })))
      .toEqual({ errorCode: 'ENOTFOUND' });
  });

  it("reads undici's wrapped cause code", () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const error = new TypeError('fetch failed', { cause });
    expect(describeTransportError(error)).toEqual({ errorCode: 'ECONNREFUSED' });
  });

  it("maps AbortSignal.timeout's TimeoutError onto a transport code", () => {
    const verdict = classifyFailure(describeTransportError(new DOMException('timed out', 'TimeoutError')));
    expect(verdict.terminal).toBe(false);
  });

  it('yields an empty descriptor when the error carries no structure', () => {
    expect(describeTransportError(new Error('boom'))).toEqual({});
  });
});

describe('describeSmtpError (#2312 AC3/AC4)', () => {
  it('carries both the reply code and the structural code', () => {
    const error = Object.assign(new Error('Invalid login'), { responseCode: 535, code: 'EAUTH' });
    expect(describeSmtpError(error)).toEqual({ smtpReplyCode: 535, errorCode: 'EAUTH' });
  });

  it('carries the structural code alone when no reply code was returned', () => {
    const error = Object.assign(new Error('self-signed certificate'), { code: 'ETLS' });
    expect(describeSmtpError(error)).toEqual({ errorCode: 'ETLS' });
  });

  it('yields an empty descriptor for a bare Error', () => {
    expect(describeSmtpError(new Error('Connection refused'))).toEqual({});
  });

  it('classifies on structure, not on message text (AC3 counterfactual)', () => {
    // Same code, wildly different wording — the verdict must not move.
    const english = Object.assign(new Error('Invalid login: 535 authentication failed'), { responseCode: 535, code: 'EAUTH' });
    const localised = Object.assign(new Error('Anmeldung fehlgeschlagen'), { responseCode: 535, code: 'EAUTH' });
    expect(classifyFailure(describeSmtpError(english))).toEqual(classifyFailure(describeSmtpError(localised)));
    expect(classifyFailure(describeSmtpError(localised)).terminal).toBe(true);
  });

  it('classifies a transient failure whose message mentions authentication as transient (AC3 inverse)', () => {
    const error = Object.assign(new Error('503 auth-service unavailable, authentication proxy down'), {
      responseCode: 421,
    });
    expect(classifyFailure(describeSmtpError(error)).terminal).toBe(false);
  });
});
