# Provider Trials · Master build prompt

Build Provider Trials in the repository supplied with this pack. The product's first complete journey is the following.

Buyer chooses a consented, held-out invoice batch and labels, freezes scoring and sample policy, and verifies provider bindings. The runner measures each provider on identical inputs under the budget. Analyst compares accepted invoice rate, valid fields, cost and latency alongside incomplete coverage.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Two bound providers each process four invoices with three mandatory fields each under the same frozen suite. A accepts three invoices with 11/12 fields and spends 12 cents; B accepts two with 9/12 fields and spends 10 cents. Display 4 and 5 cents per accepted invoice, respectively, and 4/4 coverage. Results on four samples carry a small-sample warning. If A's settlement is missing, its cost efficiency is unknown until reconciliation.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
