/**
 * The paste formats and the spread are the two things here that can be wrong
 * silently. A proxy line misread costs an emulator configured against nothing;
 * a spread that clumps costs one proxy carrying six accounts while its
 * neighbour carries one, which is exactly the pattern proxies are bought to
 * avoid. Both are pure, so both are tested without a database.
 */
import { describe, expect, it } from 'vitest';

import { parseAccountLines, parseProxyLines, spreadEvenly } from './stock.service';

describe('parseProxyLines reads what sellers actually export', () => {
  it('bare host:port', () => {
    expect(parseProxyLines('1.2.3.4:8080').valid).toEqual([
      { protocol: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' },
    ]);
  });

  it('host:port:user:pass, the colon-CSV most sellers use', () => {
    expect(parseProxyLines('gw.prox.io:31112:cust-a:s3cret').valid).toEqual([
      { protocol: 'http', host: 'gw.prox.io', port: 31112, username: 'cust-a', password: 's3cret' },
    ]);
  });

  it('keeps colons inside the password of a colon-CSV line', () => {
    expect(parseProxyLines('h.io:80:u:a:b:c').valid[0].password).toBe('a:b:c');
  });

  it('user:pass@host:port, and with a scheme in front', () => {
    expect(parseProxyLines('u:p@h.io:80').valid).toEqual([
      { protocol: 'http', host: 'h.io', port: 80, username: 'u', password: 'p' },
    ]);
    expect(parseProxyLines('socks5://u:p@h.io:1080').valid).toEqual([
      { protocol: 'socks5', host: 'h.io', port: 1080, username: 'u', password: 'p' },
    ]);
  });

  it('splits credentials at the LAST @, because passwords hold @', () => {
    expect(parseProxyLines('u:p@ss@h.io:80').valid[0]).toMatchObject({
      username: 'u',
      password: 'p@ss',
      host: 'h.io',
    });
  });

  it('keeps an @ inside a colon-CSV password instead of eating the endpoint', () => {
    // host:port:user:P@ss — an @ in the password of the commonest seller
    // format. The endpoint must survive; the @ is not a credential separator
    // here because nothing host:port-shaped follows it.
    expect(parseProxyLines('1.2.3.4:8080:cust1:P@ssw0rd').valid).toEqual([
      { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'cust1', password: 'P@ssw0rd' },
    ]);
  });

  it('rejects what is not a proxy, and says which lines', () => {
    const { valid, invalid } = parseProxyLines(
      'not a proxy\nh.io:99999\nftp://h.io:80\nh.io:80',
    );
    expect(valid).toHaveLength(1);
    expect(invalid).toEqual(['not a proxy', 'h.io:99999', 'ftp://h.io:80']);
  });

  it('dedupes within the paste on the same key the DB enforces', () => {
    // Same endpoint+user twice (passwords differ -- first wins); a different
    // user on the same endpoint is a different proxy and stays.
    const { valid } = parseProxyLines('h.io:80:u:p1\nh.io:80:u:p2\nh.io:80:v:p');
    expect(valid).toHaveLength(2);
  });
});

describe('parseAccountLines reads user:pass and user<space>pass', () => {
  it('both separators, and everything after the first is password', () => {
    expect(parseAccountLines('kris_04:pa:ss\nmia.rosee hunter2').valid).toEqual([
      { username: 'kris_04', password: 'pa:ss' },
      { username: 'mia.rosee', password: 'hunter2' },
    ]);
  });

  it('normalises the username the way the ledger does: @-stripped, lowercased', () => {
    expect(parseAccountLines('@Kris_04:pw').valid).toEqual([
      { username: 'kris_04', password: 'pw' },
    ]);
  });

  it('a line without a password is reported, not half-stored', () => {
    const { valid, invalid } = parseAccountLines('lonely_username\nok:pw');
    expect(valid).toEqual([{ username: 'ok', password: 'pw' }]);
    expect(invalid).toEqual(['lonely_username']);
  });

  it('dedupes within the paste', () => {
    expect(parseAccountLines('a_user:p1\na_user:p2').valid).toHaveLength(1);
  });
});

describe('spreadEvenly deals least-loaded first', () => {
  const loads = (deal: string[], start: { id: string; count: number }[]) => {
    const m = new Map(start.map((p) => [p.id, p.count]));
    for (const id of deal) m.set(id, (m.get(id) ?? 0) + 1);
    return [...m.values()];
  };

  it('spreads a fresh batch to within one of even', () => {
    const proxies = [
      { id: 'a', count: 0 },
      { id: 'b', count: 0 },
      { id: 'c', count: 0 },
    ];
    const after = loads(spreadEvenly(proxies, 10), proxies);
    expect(Math.max(...after) - Math.min(...after)).toBeLessThanOrEqual(1);
    expect(after.reduce((s, n) => s + n, 0)).toBe(10);
  });

  it('fills a late-added proxy before loading the others further', () => {
    // Two proxies carrying 5 each, a new one carrying 0: the next 5 accounts
    // must all land on the new one, because it is the least loaded until it
    // has caught up.
    const proxies = [
      { id: 'a', count: 5 },
      { id: 'b', count: 5 },
      { id: 'new', count: 0 },
    ];
    expect(spreadEvenly(proxies, 5)).toEqual(['new', 'new', 'new', 'new', 'new']);
  });

  it('hands back nothing when there are no proxies, rather than inventing one', () => {
    expect(spreadEvenly([], 3)).toEqual([]);
  });
});
