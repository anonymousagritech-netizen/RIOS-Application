/**
 * @rios/domain — pure reinsurance domain calculations.
 *
 * No I/O, no framework, no clock, no database. Everything here is deterministic
 * and unit-tested so financial correctness (brief §4.4) is provable in isolation.
 */

export * from './money.js';
export * from './proportional.js';
export * from './nonproportional.js';
export * from './accounting.js';
