// Domain profile: everything specific to serving veterans. The Worker's tools
// use generic names and parameters; a profile supplies the audience, the
// categories (and how they map to each source's own types), safety lines,
// and which upstream tools are offered. Copy this file to serve another
// audience (e.g. disaster recovery, disability services, legal aid) and set
// PROFILE in wrangler.toml.

export default {
  id: "veterans",
  name: "Next Mission",
  audience: "communities, families and caregivers",
  // Event YAML (project/events/<event>.yaml) with this profile's safety_lines.
  event: "next",
  tagline: "Set goals for your Next Mission",

  // category id -> label, plus the upstream directory's matching type.
  categories: {
    medical_center: { label: "VA medical center", upstream: "va_hospital" },
    clinic: { label: "Outpatient clinic", upstream: "va_clinic" },
    counseling_center: { label: "Vet Center (readjustment counseling)", upstream: "vet_center" },
    benefits_office: { label: "Benefits office", upstream: "benefits_office" },
    mental_health: { label: "Mental health", upstream: "mental_health" },
    housing: { label: "Housing", upstream: "housing" },
    employment: { label: "Employment and training", upstream: "employment" },
    peer_support: { label: "Peer and membership organization", upstream: "vso" },
    other: { label: "Other", upstream: "other" },
  },

  // Optional focus filters passed through to the upstream directory.
  specialties: ["women", "lgbtq", "tribal", "mst", "homeless", "crisis", "student", "caregiver", "combat", "telehealth"],

  safety: {
    // Checked on every free-text input before anything else runs. A match
    // puts the lines below at the top of the response.
    patterns: [
      /\bsuicid/i, /\bkill(ing)? (my ?self|me)\b/i, /\bend (my|it all|my life)\b/i, /\bwant(ed)? to die\b/i,
      /\bbetter off dead\b/i, /\bno reason to live\b/i, /\bself[- ]?harm/i, /\bhurt(ing)? my ?self\b/i,
      /\bcan'?t go on\b/i, /\boverdos/i, /\bhopeless\b/i, /\bnot worth living\b/i, /\bgive up on life\b/i,
      /\bgun to my head\b/i, /\bgoodbye (letter|note)\b/i, /\bin crisis\b/i,
    ],
    // Filled from the event YAML's safety_lines (src/event.js).
    lines: [],
    message: "If you or someone you know is in crisis, help is available right now, free and confidential.",
  },

  // Upstream directory tools offered under generic names (src/tools.js),
  // with how generic arguments translate to the upstream's own.
  upstream: {
    source_id: "upstream-directory",
    generic: {
      lookup_form: { tool: "lookup_va_form", args: { form_number: "form_id", category: "category" } },
      define_term: { tool: "define_veteran_term", args: { term: "term" } },
      check_eligibility: {
        tool: "check_eligibility",
        args: {
          era: "era", branch: "branch", discharge: "discharge", conditions: "conditions", state: "region",
          household_income: "household_income", dependents: "dependents", disability_rating: "disability_rating",
          homeless: "homeless", at_risk_homeless: "at_risk_homeless", age_65_or_disabled: "age_65_or_disabled",
        },
      },
      get_region_benefits: { tool: "get_state_veteran_benefits", args: { state: "region", category: "category" } },
      find_representative: { tool: "find_accredited_representative", args: { state: "region", type: "type", zip: "postal_code" } },
      find_county_officer: { tool: "find_cvso", args: { state: "region", county: "county", zip: "postal_code" } },
      estimate_benefit: { tool: "calculate_va_benefits", args: { type: "type", rating: "rating", serviceYears: "service_years" } },
      match_exposure_conditions: { tool: "match_pact_presumptive", args: { era: "era", deployment_country: "deployment_country", symptoms: "symptoms" } },
      get_workflow: { tool: "get_workflow", args: { slug: "slug" } },
      get_records_access: { tool: "get_records_access", args: { type: "type" } },
      get_family_resources: { tool: "get_family_resources", args: { type: "type" } },
    },
  },

  // The three NSF objectives, used by the frontend and the about tool.
  objectives: [
    { id: 1, title: "Extract and Integrate", text: "Apply AI to feature extraction, metadata generation and the integration of many datasets." },
    { id: 2, title: "Pipeline Automation", text: "Robust pipelines so AI tools can analyze existing datasets and similar use cases." },
    { id: 3, title: "Harmonized AI Data", text: "Augment and harmonize datasets so AI pipelines and automated analysis can use them." },
  ],
};
