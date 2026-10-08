import { randomUUID } from 'node:crypto';

// Targeted savings stay with their goal: `reconcile` lets the automatic shares of
// the savings accounts' balance make room for them, taking from the other goals first.
export function installGoalSavings(app, { one, all, run, atomic, owned, fail, cents, now, reconcile = async () => {} }) {
  app.post('/api/goals/:id/contributions', async (req, res) => {
    const amount = cents(req.body.amount);
    const id = randomUUID();
    await atomic(async () => {
      const goal = await owned('goals', req.params.id, req.user);
      const saved = cents(goal.saved + amount, true);
      await run('UPDATE goals SET saved = ? WHERE id = ? AND household_id = ?', saved, goal.id, req.user.household_id);
      await run('INSERT INTO contributions VALUES (?, ?, ?, ?, ?)', id, goal.id, amount, req.user.id, now());
      await reconcile(req.user.household_id, goal.id);
    });
    res.status(201).json({ ok: true, id });
  });
  async function updateInitial(req, res) {
    const amount = req.method === 'DELETE' ? 0 : cents(req.body.amount, true);
    await atomic(async () => {
      const goal = await owned('goals', req.params.id, req.user);
      const contributions = await one('SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE goal_id = ?', goal.id);
      const saved = cents(contributions.total + amount, true);
      await run('UPDATE goals SET saved = ? WHERE id = ? AND household_id = ?', saved, goal.id, req.user.household_id);
      await reconcile(req.user.household_id, goal.id);
    });
    res.json({ ok: true });
  }
  app.put('/api/goals/:id/initial-savings', updateInitial);
  app.delete('/api/goals/:id/initial-savings', updateInitial);
  async function updateContribution(req, res) {
    const amount = req.method === 'DELETE' ? 0 : cents(req.body.amount);
    await atomic(async () => {
      const goal = await owned('goals', req.params.id, req.user);
      const contribution = await one('SELECT * FROM contributions WHERE id = ? AND goal_id = ?', req.params.contributionId, goal.id);
      if (!contribution) fail('Accantonamento non trovato.', 404);
      const saved = cents(goal.saved - contribution.amount + amount, true);
      if (req.method === 'DELETE') await run('DELETE FROM contributions WHERE id = ? AND goal_id = ?', contribution.id, goal.id);
      else await run('UPDATE contributions SET amount = ? WHERE id = ? AND goal_id = ?', amount, contribution.id, goal.id);
      if (req.method === 'DELETE') await run('DELETE FROM savings_balance_allocations WHERE contribution_id = ?', contribution.id);
      await run('UPDATE goals SET saved = ? WHERE id = ? AND household_id = ?', saved, goal.id, req.user.household_id);
      await reconcile(req.user.household_id, goal.id);
    });
    res.json({ ok: true });
  }
  app.put('/api/goals/:id/contributions/:contributionId', updateContribution);
  app.delete('/api/goals/:id/contributions/:contributionId', updateContribution);
  return {
    state(householdId) {
      // Keep totals and their breakdown consistent across serverless writers.
      return atomic(async () => ({
        goals: await all(`SELECT g.*, g.saved - COALESCE((SELECT SUM(c.amount) FROM contributions c WHERE c.goal_id = g.id), 0) AS initial_saved,
          COALESCE(p.monthly, 0) AS monthly, COALESCE(p.is_primary, 0) AS is_primary
          FROM goals g LEFT JOIN goal_plans p ON p.goal_id = g.id WHERE g.household_id = ? ORDER BY g.created_at DESC`, householdId),
        contributions: await all(`SELECT c.*, u.name AS author, CASE WHEN EXISTS (SELECT 1 FROM savings_balance_allocations b WHERE b.contribution_id = c.id) THEN 1 ELSE 0 END AS automatic
          FROM contributions c JOIN goals g ON g.id = c.goal_id JOIN users u ON u.id = c.author_id WHERE g.household_id = ? ORDER BY c.created_at DESC, c.id`, householdId),
      }));
    },
  };
}
