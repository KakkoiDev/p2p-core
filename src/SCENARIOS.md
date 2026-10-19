# Scenarios: rooms (`joinRoom`)

What a game gets from one `joinRoom` call, as Given/When/Then scenarios. Each one is an end-to-end test of the same
title in `e2e/journeys.test.js`: real rooms on the in-memory test network (`createTestNetwork()`), no browser, no
internet. `python3 test-core/tools/scenarios.py check src/SCENARIOS.md --tests e2e/journeys.test.js` proves every
scenario has its test; CI also requires that each one ran and passed.

### Scenario: Two players meet in a room
- Given Ann and Ben open the same game and room on one network
- When the network settles
- Then Ann sees Ben with his profile name
- And Ben sees Ann with hers

### Scenario: A message to everyone reaches every other player
- Given Ann, Ben and Cat are in one room
- When Ann sends the chat message "hello" to everyone
- Then Ben and Cat each receive "hello" from Ann
- And Ann does not receive her own message

### Scenario: A message to one player reaches only that player
- Given Ann, Ben and Cat are in one room
- When Ann sends a secret to Ben only
- Then Ben receives the secret
- And Cat receives nothing

### Scenario: A player who leaves disappears for the others
- Given Ann and Ben are in one room
- When Ben leaves the room
- Then Ann is told Ben left
- And Ann's room counts no other players

### Scenario: A lost connection is seen as a leave
- Given Ann and Ben are in one room
- When Ben's connection drops
- Then Ann is told Ben left

### Scenario: A player on another protocol version is refused with a reason
- Given Ann's game speaks protocol 2
- When Ben joins with protocol 1
- Then Ann refuses Ben with the reason "version"
- And neither counts the other as a player

### Scenario: A private room lets in only players with the same password
- Given Ann opens a room with the password "secret"
- When Ben joins with "secret" and Cat joins with "wrong"
- Then Ann and Ben see each other
- And Cat sees nobody

### Scenario: A full room refuses one more player
- Given Ann's room allows one other player
- When Ben and then Cat join
- Then Ann plays with Ben
- And Ann refuses Cat with the reason "full"

### Scenario: Everyone agrees on the host, and the next one takes over when the host leaves
- Given three players are in one room
- When they compare who is host
- Then all three name the same player, without sending a message about it
- And when that host leaves, the two others agree on a new host

### Scenario: Data that fails validation never reaches the game
- Given Ben's game accepts only moves with a number x
- When Ann sends a move with x "far" and then a move with x 3
- Then Ben's game receives only the move with x 3
- And Ben's room counts one invalid message dropped

### Scenario: A new profile name reaches the other players
- Given Ann and Ben are in one room
- When Ben changes his name to "Bee"
- Then Ann is told of the update
- And Ann sees Ben as "Bee"
