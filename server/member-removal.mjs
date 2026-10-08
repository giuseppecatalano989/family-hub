// Operator-only maintenance: no HTTP endpoint. The request identifier prevents
// a retried deployment from deleting a newly recreated account with that name.
export async function removeMember({ db, requestId, memberName, adminName, takeBackup }) {
  if (!db.cloud || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId || '') || !memberName?.trim() || !adminName?.trim() || typeof takeBackup !== 'function') {
    throw new Error('Configurazione della rimozione non valida.');
  }
  return db.atomic(async () => {
    await db.prepare('CREATE TABLE IF NOT EXISTS member_removals (request_id TEXT PRIMARY KEY, result TEXT NOT NULL)').run();
    const previous = await db.prepare('SELECT result FROM member_removals WHERE request_id = ?').get(requestId);
    if (previous) return { ...JSON.parse(previous.result), repeated: true };
    const matches = await db.prepare(`SELECT member.id, admin.id AS admin_id FROM users member
      JOIN users admin ON admin.household_id = member.household_id AND admin.role = 'admin'
      WHERE member.role = 'member' AND lower(trim(member.name)) = lower(trim(?))
      AND lower(trim(admin.name)) = lower(trim(?))`).all(memberName, adminName);
    if (matches.length !== 1) throw new Error('Account da rimuovere non identificato in modo univoco nella famiglia indicata. Nessun account eliminato.');
    const { id, admin_id: adminId } = matches[0];
    const backup = await takeBackup();
    if (!backup?.id) throw new Error('Copia privata non confermata. Nessun account eliminato.');
    let preservedRecords = 0;
    for (const table of ['transactions', 'contributions', 'shopping', 'notes', 'meals', 'recurring_rules', 'deadline_receipts']) {
      const result = await db.prepare(`UPDATE ${table} SET author_id = ? WHERE author_id = ?`).run(adminId, id);
      preservedRecords += result.changes;
    }
    await db.prepare('DELETE FROM file_uploads WHERE user_id = ?').run(id);
    // Removes the member's bank links, balances and copied movements; imported records stay.
    await db.prepare('DELETE FROM bank_auth_requests WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM bank_account_exclusions WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM dashboard_preferences WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM notification_log WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM bank_connections WHERE user_id = ?').run(id);
    // Private records keep counting in the budget without revealing their details.
    await db.prepare("UPDATE transactions SET description = 'Movimento bancario privato' WHERE id IN (SELECT transaction_id FROM private_transactions WHERE owner_id = ?)").run(id);
    await db.prepare('DELETE FROM private_transactions WHERE owner_id = ?').run(id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(id);
    const removed = await db.prepare("DELETE FROM users WHERE id = ? AND role = 'member'").run(id);
    if (removed.changes !== 1) throw new Error('Rimozione non confermata.');
    const result = { removed: true, preservedRecords, backupId: backup.id };
    await db.prepare('INSERT INTO member_removals VALUES (?, ?)').run(requestId, JSON.stringify(result));
    return result;
  });
}
