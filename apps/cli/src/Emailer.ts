import { Command } from "effect/unstable/cli";

import { addresses } from "./commands/Addresses.ts";
import { campaigns } from "./commands/Campaigns.ts";
import { contacts } from "./commands/Contacts.ts";
import { keys } from "./commands/Keys.ts";
import { lists } from "./commands/Lists.ts";

export const emailer = Command.make("emailer").pipe(
  Command.withDescription("Manage contacts, lists, campaigns, addresses and keys"),
  Command.withSubcommands([contacts, lists, campaigns, addresses, keys]),
);
