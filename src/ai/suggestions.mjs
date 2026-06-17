/**
 * Role-aware starter questions for the AI Assistant empty state.
 *
 * Producers/admins (the people who run dispatch) get operation-wide questions;
 * contractors (customers) get questions scoped to their OWN orders/deliveries.
 * The contractor data itself is hard-scoped in query-executor.mjs — this list
 * just shows the right prompts for each audience.
 */

const PRODUCER_SUGGESTIONS = [
  "How many yards did we deliver last week?",
  "Which customer ordered the most yards this month?",
  "Which plant produced the most yards yesterday?",
  "How many trucks ran this week?",
  "How many late tickets this week?",
  "How many open orders right now?",
];

const CONTRACTOR_SUGGESTIONS = [
  "What's the status of my orders today?",
  "When will my next delivery arrive?",
  "How many yards have I received this week?",
  "What's my delivery schedule for this week?",
  "Were my deliveries on time this week?",
  "Show my open orders.",
];

/**
 * @param {'admin'|'producer'|'contractor'|null|undefined} userType
 * @returns {{ userType: string, suggestions: string[] }}
 */
export function getSuggestions(userType) {
  if (userType === "contractor") {
    return { userType: "contractor", suggestions: CONTRACTOR_SUGGESTIONS };
  }
  // admin + producer (and unknown) get the operations view.
  return { userType: userType || "producer", suggestions: PRODUCER_SUGGESTIONS };
}
