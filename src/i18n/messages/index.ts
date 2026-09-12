import { appEn, appHu } from './app';
import { helpEn, helpHu } from './help';
import { studioEn, studioHu } from './studio';

/**
 * All interface texts. Each area file defines English first; its Hungarian
 * table is typed against the English keys, so a missing translation is a
 * compile error rather than a blank label.
 */
const en = { ...appEn, ...studioEn, ...helpEn };

export type MessageKey = keyof typeof en;

const hu: Record<MessageKey, string> = { ...appHu, ...studioHu, ...helpHu };

export const MESSAGES: Readonly<Record<'en' | 'hu', Readonly<Record<MessageKey, string>>>> = { en, hu };
