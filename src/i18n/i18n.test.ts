import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { lang, resolveLang, setLang, t } from './index';
import { ko } from './ko';

describe('i18n', () => {
  afterEach(() => setLang('ko'));

  it('en and ko have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  it('resolves language from locale (same rule as the native menu)', () => {
    expect(resolveLang('ko-KR')).toBe('ko');
    expect(resolveLang('ko')).toBe('ko');
    expect(resolveLang('en-US')).toBe('en');
    expect(resolveLang('ja-JP')).toBe('en');
    expect(resolveLang(null)).toBe('en');
    expect(resolveLang(undefined)).toBe('en');
    expect(resolveLang('')).toBe('en');
  });

  it('translates plain strings and interpolates params', () => {
    setLang('ko');
    expect(lang).toBe('ko');
    expect(t('common.cancel')).toBe('취소');
    expect(t('cb.start', { name: 'main' })).toBe('시작 지점: main');
    setLang('en');
    expect(lang).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('cb.start', { name: 'main' })).toBe('Start point: main');
  });

  it('pluralizes in English', () => {
    setLang('en');
    expect(t('changes.files', { n: 1 })).toBe('1 file');
    expect(t('changes.files', { n: 2 })).toBe('2 files');
    expect(t('details.multi', { n: 1200 })).toBe('1,200 commits selected');
    setLang('ko');
    expect(t('changes.files', { n: 2 })).toBe('2개 파일');
  });
});
