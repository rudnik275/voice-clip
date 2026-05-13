import { describe, expect, test } from 'bun:test'
import { createAllowlist, parseAllowedEmails } from '../src/allowlist'

describe('allowlist.parseAllowedEmails', () => {
  test('empty input → empty array', () => {
    expect(parseAllowedEmails('')).toEqual([])
    expect(parseAllowedEmails(undefined)).toEqual([])
  })

  test('single email is preserved', () => {
    expect(parseAllowedEmails('foo@example.com')).toEqual(['foo@example.com'])
  })

  test('comma-separated list is split + trimmed', () => {
    expect(parseAllowedEmails('a@x.com, b@y.com ,c@z.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ])
  })

  test('emails are lowercased so allowlist is case-insensitive', () => {
    expect(parseAllowedEmails('Foo@Example.COM')).toEqual(['foo@example.com'])
  })

  test('empty entries (extra commas) are dropped', () => {
    expect(parseAllowedEmails('a@x.com,, ,b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })
})

describe('allowlist.createAllowlist', () => {
  test('isAllowed returns true for listed email', () => {
    const al = createAllowlist(['foo@example.com', 'bar@example.com'])
    expect(al.isAllowed('foo@example.com')).toBe(true)
    expect(al.isAllowed('bar@example.com')).toBe(true)
  })

  test('isAllowed returns false for unlisted email', () => {
    const al = createAllowlist(['foo@example.com'])
    expect(al.isAllowed('baz@example.com')).toBe(false)
  })

  test('isAllowed is case-insensitive', () => {
    const al = createAllowlist(['foo@example.com'])
    expect(al.isAllowed('FOO@EXAMPLE.COM')).toBe(true)
    expect(al.isAllowed('Foo@Example.Com')).toBe(true)
  })

  test('isAllowed trims surrounding whitespace before checking', () => {
    const al = createAllowlist(['foo@example.com'])
    expect(al.isAllowed('  foo@example.com  ')).toBe(true)
  })

  test('empty allowlist rejects everything (fail-closed)', () => {
    const al = createAllowlist([])
    expect(al.isAllowed('foo@example.com')).toBe(false)
  })
})
