import type { DecisionRecord, Theme } from "../projects";

// WAG-260: the `project` topic of waggle_guide. ASD-STE100 text: short sentences, one meaning per word.

export interface ProjectGuideData {
  project: string;
  decisions: DecisionRecord[];
  themes: Theme[];
  repoRecords: boolean;
  stale: boolean;
  comments: string[];
}

export const PROJECT_TOPIC_PLACEHOLDER =
  "This topic is about one project. It needs a Waggle session.\n\nWRONG: a call from a client with no session.\n\nright: call waggle_guide with topic project from inside a Waggle session.\n";

export function projectGuide(d: ProjectGuideData): string {
  const out: string[] = [`## ${d.project}: recent decisions`, ""];
  out.push("Read this one time in each session, before you build UI. Do not ask these questions again. Follow the pick.", "");
  if (d.decisions.length === 0) out.push("There are no decisions yet.");
  for (const x of d.decisions) {
    out.push(`- ${x.question} ${x.pick} (${x.decided_at.slice(0, 10)}).`, `  Why: ${x.why.replace(/\s+/g, " ")}`);
  }
  out.push(
    "",
    "## Read the decision records first",
    "",
    "If the repo has a docs/decisions folder, read the records in it before you ask. Do not ask again what a record already answers.",
    "Follow the record. If you think it is wrong, say so in an ask and name the record.",
  );
  out.push("", "## The operator's themes", "");
  const on = d.themes.filter((t) => t.enabled);
  if (on.length === 0) out.push("No themes are on.");
  for (const t of on) out.push(`- ${t.text} (${t.evidence_count}).`);
  if (on.length > 0) out.push("", "Apply these before you send a prototype.");
  if (d.repoRecords) {
    out.push(
      "",
      "## Write a record for each decision",
      "",
      "The person wants a record of each decision in the repo.",
      "After a decision, write one markdown file in your own repo: docs/decisions/YYYY-MM-DD-<slug>.md.",
      "The file has these parts: question, options, pick, why, date.",
      "Commit the file with your work. Waggle does not write into your repo.",
    );
  }
  if (d.stale) {
    out.push(
      "",
      "## Propose themes",
      "",
      "The themes are out of date. Read the comments below. They are the last operator comments in this project, newest first.",
      "Find the taste they show. Then call waggle_themes with action propose.",
      "Send up to 8 themes. Each theme has text, evidence_count and quotes (up to 3 short quotes).",
      "Each theme has a scope. Use project (the default) for a rule about this project. Use all for a short rule that holds in every project.",
      "A rule with scope all must name no project and hold no project content. Agents in other projects read it.",
      "Write each theme as one short rule. Do not turn on a theme the person turned off.",
      "",
    );
    if (d.comments.length === 0) out.push("There are no comments yet. Do not propose themes.");
    d.comments.forEach((c, i) => out.push(`${i + 1}. ${c.replace(/\s+/g, " ")}`));
  }
  return `${out.join("\n")}\n`;
}
