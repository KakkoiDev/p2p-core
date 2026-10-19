# Scenarios: the examples (`examples/index.html`, `examples/match.html`)

What a person sees on the playground and the rock-paper-scissors page. Each scenario is one test of the same title in
`e2e/browser.spec.mjs`: real Chromium pages, the real local server, real WebRTC, and trystero's real signalling through
a local nostr relay. Separate browser contexts stand in for separate browsers. No request leaves the machine.

### Scenario: Two tabs of one browser meet with no network
- Given the playground is open in one tab as "ann" in tabs mode
- When a second tab opens it as "ben" in the same room
- Then each tab sees one other player over the tabs transport
- And ann sees ben's name

### Scenario: A chat message typed in one tab appears in the other
- Given ann and ben have the playground open in two tabs of one room
- When ann types "hello from ann" in the message box and presses Send
- Then ben's log shows "ann: hello from ann"
- And ann's log shows "me: hello from ann"

### Scenario: Arrow keys move my dot in the other tab
- Given ann and ben have the playground open in two tabs of one room
- When ann focuses the playground and presses the right arrow five times
- Then ann's dot moves right in ben's tab

### Scenario: Closing a tab removes its player
- Given ann and ben have the playground open in two tabs of one room
- When ben's tab closes
- Then ann sees no other player
- And ann's log says "ben left"

### Scenario: Two browsers meet through the local server they were loaded from
- Given two browsers open the playground in offline mode, in one room
- When the server introduces them
- Then each sees the other over the server transport
- And a chat message from one arrives in the other

### Scenario: Each player is reached the best way
- Given ann and ben meet through the local server in two browsers
- When cat opens a second tab in ann's browser
- Then cat reaches ann by tab and ben by the server

### Scenario: Tabs of one browser ignore each other when same-browser play is off
- Given ann and ben open two tabs of one browser with same-browser play off
- When cat joins the room from another browser
- Then cat sees both
- And ann and ben see only cat, even through the server

### Scenario: Choosing a mode reloads the playground in that mode
- Given the playground is open in offline mode
- When I choose "tabs — this browser only" in the Mode list
- Then the page reloads with mode=tabs in its address
- And the room plans only the tabs transport

### Scenario: The connection badge counts the other players
- Given ann has the playground open alone in tabs mode
- When ben opens it in another tab of the same room
- Then ann's badge reads "1 other player" and "other tabs: on"

### Scenario: Two browsers pair by code with no server and no relays
- Given two browsers with no server and no internet
- When the first makes an invite code, the second accepts it, and the first finishes with the answer
- Then both are paired over the pair transport, on a direct local route
- And a chat message arrives

### Scenario: A third device reaches everyone through the inviter
- Given ann is paired with ben
- When cat pairs with ann too
- Then cat and ben see each other through ann
- And cat's message reaches ben

### Scenario: An answer pasted as an invite gets a clear error
- Given cat has an answer code meant for ann
- When cat pastes it where an invite goes
- Then the error says it is an answer code

### Scenario: Two browsers meet over the internet through a relay
- Given two browsers open the playground in online mode with one local nostr relay
- When trystero signals through the relay
- Then they connect over WebRTC on a local route, so "other networks off" still lets them in
- And a chat message arrives, relay health is reported, and ping answers

### Scenario: The invite link shows this match's address
- Given the rock paper scissors page opens with a match id after the #
- When I read the Invite link box
- Then it holds the page's address, match id included

### Scenario: Two tabs are matched and a third is told the room is full
- Given three tabs open the same rock paper scissors link
- When matchmaking settles
- Then two are matched and the third reads "Two people are already playing here"

### Scenario: Rock beats scissors
- Given two players are matched
- When one picks Rock and the other Scissors
- Then the first reads "You win" and the second "You lose"

### Scenario: Paper against paper is a draw
- Given two players are matched
- When both pick Paper
- Then both read "Draw"
