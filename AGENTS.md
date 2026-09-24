We're building an AWS SES powered marketing / mass email sending service - using DynamoDB, Lambda, SQS, SNS, EventBridge and others.
We're using Alchemy (alchemy.run) and Effect (effect.website). Also see the ./wiki folder to learn more about involved key technologies and libraries.

# RULES

- Linting, testing and other errors and warnings must be taken seriously and should be fixed properly
- You should ALWAYS evaluate alternatives and go for the cleanest solution and implemention, NEVER for the quick fix or workaround
- ALWAYS properly consult the wiki when working on code - do NOT make guesses or blind assumptions
- Dive deeper with wiki-linked resources and perform additional in-depth web research as needed to ensure you operate on proper up-to-date knowledge
- Evaluate your work by running automated tests and by testing manually
- If you work with worktrees, you own that tree, and you must handle merging back as well as worktree cleanup!
- Document key decisions and findings as "ADS"s (Architecture Decision Records) in an `.adr` folder (which is to be committed)
- Test deployments are absolutely wanted - use `--stage test` with Alchemy => but keep those deployments ephemeral
- The repository is public: never put details specific to the operator or their company (names, brands, vendors, domains, addresses, account or infrastructure identifiers) into code, tests, fixtures or docs - use neutral placeholders such as `example.com`
