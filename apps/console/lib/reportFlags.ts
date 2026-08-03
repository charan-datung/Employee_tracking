// ============================================================================
// DURATION / HOURS COLUMNS ARE OFF BY DEFAULT AND THAT IS DELIBERATE.
//
// NEXT_PUBLIC_SHOW_DURATION must be the exact string 'true' to enable them.
// Anything else — unset, 'false', '1', 'yes' — keeps them hidden.
//
// WHY: this app records ATTENDANCE EVENTS (check-in, check-out, visits). It
// does not record hours worked, and the database schema deliberately contains
// no such column (CLAUDE.md rule 8). The moment a console renders a "hours"
// or "duration" column, that number starts being used — for pay, for
// discipline, for arguments — and under Article 82 of the Philippine Labor
// Code, field personnel whose actual hours cannot be determined with
// reasonable certainty are treated differently from ordinary employees. A
// derived elapsed-time column would BE a determination of hours, computed
// from GPS check-ins that were never designed to be a time clock.
//
// So: enabling this is a labor-law decision, not a UI preference. Ask the
// owner AND counsel before flipping it, and expect to revisit how check-out
// is enforced if you do — an agent who forgets to check out currently gets
// auto-closed at 16h with NULL coordinates, which would become a 16-hour
// "shift" the instant this is on.
// ============================================================================
export const SHOW_DURATION = process.env.NEXT_PUBLIC_SHOW_DURATION === 'true';
