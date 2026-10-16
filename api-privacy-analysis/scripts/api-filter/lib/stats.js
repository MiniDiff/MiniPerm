'use strict';
// Statistical judgment rules for provenance pruning, corresponding to scheme c)-ii) the "pruning criteria" and "automation tiering" tables.
// Purely numeric computation; no LLM calls involved.

function falsePositiveRate(stats) {
  if (!stats || !stats.hitCount) return 0;
  return stats.rejectedCount / stats.hitCount;
}

/**
 * Performs pruning tiering judgment on a single K_doc / K_code / R term, returning:
 * - tier: 'keep' | 'keep-caution' | 'tier1-suspend' | 'tier2-suggest-suspend' | 'tier2-suggest-downgrade'
 * - reason: a human-readable judgment rationale (written into the per-round summary table)
 *
 * The judgment order strictly follows the scheme table: when uniqueContribution > 0 it has the highest protection priority (automatic pruning is forbidden, even if the false-positive rate is high);
 * next comes long-term zero hits (Tier1, fully automatic); after that, a too-high false-positive rate or complete redundancy (Tier2, advisory only and not executed).
 */
function classifyTier(stats, currentRound, zeroHitRoundsThreshold) {
  zeroHitRoundsThreshold = zeroHitRoundsThreshold || 3;

  if (stats.uniqueContribution > 0) {
    return {
      tier: 'keep-caution',
      reason:
        'has a unique contribution (uniqueContribution=' +
        stats.uniqueContribution +
        '), automatic pruning is forbidden; no matter how high the false-positive rate, it is only marked "keep with caution", because pruning it is equivalent to blocking a lead already proven effective',
    };
  }

  const neverHit = stats.hitCount === 0;
  const staleForRounds = currentRound - (stats.lastHitRound || 0) >= zeroHitRoundsThreshold;
  if (neverHit || staleForRounds) {
    return {
      tier: 'tier1-suspend',
      reason: neverHit
        ? 'has never produced any hit since it was added; suspending it carries zero risk'
        : 'produced no new hits for more than ' + zeroHitRoundsThreshold + ' consecutive rounds; suspending it carries zero risk',
    };
  }

  const fpr = falsePositiveRate(stats);
  if (stats.hitCount >= 5 && fpr >= 0.8) {
    return {
      tier: 'tier2-suggest-suspend',
      reason:
        'false-positive rate too high (hits: ' +
        stats.hitCount +
        ', false-positive rate ' +
        (fpr * 100).toFixed(1) +
        '%), the term is too broad: it consumes judgment rounds while producing almost nothing; recommend observing or suspending',
    };
  }

  if (stats.confirmedCount > 0 && stats.uniqueContribution === 0) {
    return {
      tier: 'tier2-suggest-downgrade',
      reason: 'completely redundant: every API it helped confirm is also hit by other active terms, so removing it loses no known finding',
    };
  }

  return { tier: 'keep', reason: '' };
}

module.exports = { falsePositiveRate, classifyTier };
