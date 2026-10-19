# Scenarios: extras

The ready-made pieces over a room: matchmaking, presence, shared state and the pairing dialog. Two-peer journeys run on
the in-memory test network in `e2e/journeys.test.js`; the pairing dialog runs in real Chromium in
`e2e/browser.spec.mjs`. Each scenario is one test of the same title.

### Scenario: Two players are matched and exactly one hosts
- Given Ann and Ben look for a 1-on-1 match in the same room
- When matchmaking finishes
- Then each is matched with the other
- And exactly one of them is the host

### Scenario: A third player is told the room is full and never hears the game
- Given Ann, Ben and Cat look for a 1-on-1 match in the same room
- When two of them are matched
- Then the third is told the room is full
- And a move between the matched two never reaches the third

### Scenario: A matched player's move reaches the opponent
- Given Ann and Ben are matched
- When Ann sends the move "e4"
- Then Ben receives "e4"

### Scenario: The opponent leaving is reported
- Given Ann and Ben are matched
- When Ben leaves
- Then Ann is told her opponent left

### Scenario: A moving player's position reaches the others
- Given Ann and Ben share their positions with presence
- When Ann moves to x 40, y 25
- Then Ben's latest state for Ann is x 40, y 25

### Scenario: Shared state reaches everyone, including a player who joins late
- Given Ann and Ben share state that starts at level 1
- When Ann sets the level to 2
- Then Ben sees level 2
- And Cat, who joins afterwards, also sees level 2

### Scenario: The status line says how many players are here
- Given Ann and Ben are in one room on the test network
- When Ann describes her room's status
- Then it reads "1 other player · test network"

### Scenario: Two browsers pair through the dialog by pasting codes
- Given two browsers open the playground with no server and no internet
- When the first chooses "Invite a device" and the second pastes that code under "Join with a code" and connects
- And the first, who is also offered "Scan answer", pastes the answer code and connects
- Then both are paired
- And the dialog closes itself

### Scenario: The invite QR code reads back as the same code
- Given the pairing dialog shows an invite
- When its QR code is drawn and read back from the pixels
- Then the text read is the invite code

### Scenario: Copy code puts the invite on the clipboard
- Given the pairing dialog shows an invite
- When I press "Copy code"
- Then the clipboard holds the invite code
- And the button says "Copied"

### Scenario: Back returns to the start of the dialog and Close cancels pairing
- Given the pairing dialog is open
- When I choose "Join with a code" and then "Back"
- Then I see "Invite a device" again
- And when I press "Close" the dialog is gone

### Scenario: Scanning starts the camera and Stop camera stops it
- Given the pairing dialog shows "Join with a code" on a device with a camera
- When I press "Scan invite"
- Then the camera view shows and the button says "Stop camera"
- And when I press "Stop camera" the camera view hides
