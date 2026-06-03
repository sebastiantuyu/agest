export const softwareLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "agest",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Node.js 22+",
    "description": "Quantitative testing framework for AI agents. Measure behavior coverage and statistical confidence, track token and USD cost, and enforce a quality bar your team defines in version-controlled config.",
    "url": "https://sebastiantuyu.github.io/agest/",
    "downloadUrl": "https://www.npmjs.com/package/@sebastiantuyu/agest",
    "codeRepository": "https://github.com/sebastiantuyu/agest",
    "programmingLanguage": "TypeScript",
    "license": "https://opensource.org/licenses/MIT",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Person", "name": "Sebastian Tuyu", "url": "https://sebastiantuyu.com" }
  };

export const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "What is agest?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "agest is a quantitative, framework-agnostic TypeScript framework for testing AI agent behavior. You run test scenarios (\"scenes\") against a real agent and get behavior coverage, a pass rate with a statistical confidence interval, token and USD cost, and a run history you can diff — all scored against a quality bar your team defines in config."
        }
      },
      {
        "@type": "Question",
        "name": "How do you test an AI agent?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Write scenes that pair a prompt with assertions about the agent's behavior — refusal, content, tool use, schema-valid output, or an LLM-as-judge for fuzzy qualities. Run them with the agest CLI, and repeat each scene with .runs(n) to get a pass rate with a confidence interval instead of a single pass or fail."
        }
      },
      {
        "@type": "Question",
        "name": "How do you measure test coverage for an AI agent?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "agest tracks coverage across capability areas — refusal, correctness, format, tool-use, memory, performance, and robustness. The coverage radar shows which behaviors are tested, how well they pass, and where your confidence is still too thin to trust, so 'untested' and 'tested but not enough' become distinct, visible states."
        }
      },
      {
        "@type": "Question",
        "name": "How is agest different from a visual agent builder or a hosted eval platform?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Unlike visual agent builders, agest does not build the agent — it measures and enforces its behavior in your codebase and CI. Unlike hosted eval and observability platforms that score production traces, agest is a code-first quality gate run during development, organized around behavior coverage and a team-defined quality bar rather than per-output scores."
        }
      },
      {
        "@type": "Question",
        "name": "Is agest tied to a specific framework or model provider?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "No. You wrap any agent in a one-line executor function, so agest works with a raw model SDK, LangChain or LangGraph, or any agent behind an HTTP endpoint. It is provider- and framework-agnostic."
        }
      },
      {
        "@type": "Question",
        "name": "Is agest open source?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Yes. agest is MIT-licensed and written in TypeScript for Node.js 22+. Install it with: npm i -D @sebastiantuyu/agest."
        }
      }
    ]
  };
