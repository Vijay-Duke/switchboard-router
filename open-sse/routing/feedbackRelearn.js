const g = (global.__feedbackRelearn ??= { counts: Object.create(null) });

export function recordRatingForRelearn(comboName, threshold = 3) {
  if (!comboName) return false;
  g.counts[comboName] = (g.counts[comboName] || 0) + 1;
  if (g.counts[comboName] >= threshold) {
    g.counts[comboName] = 0;
    return true;
  }
  return false;
}

export function resetFeedbackRelearn() {
  g.counts = Object.create(null);
}
