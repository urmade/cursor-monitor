           0 (%0)           ane — Vision & Feature Spec (PoC)
  Go To Top            (<)  
  Go To Bottom         (>)   built on Cursor for teams where **AI agents execute and h
                            *. This document is the single source of truth for PoC sco
  Search For Agentic (C-r)  r implementation planning.
  Type Agentic       (C-y)  
  Copy Agentic         (c)  
  Copy Line            (l)  
                            
  Horizontal Split     (h)  
  Vertical Split       (v)  an is the worker and the tool is the record. In an agentic
                            n is cheap, parallel, and fast; **human attention is the b
  Swap Up                   
  Swap Down                 
  Swap Marked               with agents." It is a **control plane**:
                            
  Kill                 (X)  owns |
  Respawn              (R)  
  Mark                 (m)  es, labels | Cloud Agents / Automations (the actual agenti
  Zoom                      
                             Agent runtime, models, sandboxes, environments |
| Derived state, attention routing | Code review (Bugbot, Cursor Review) |
| Run tracking, cost, loops | Code intelligence, editor, chat surfaces |
| Specs and decision memory (in our DB) | Repositories |
| Orchestration (which automation fires when) | Creating and editing Automations |
**Core operating rule:** the system tracks state and enforces policy. Any actual agent
ic work happens outside the system through **Cursor Automations**. The system selects
which automation to run at a stage, passes a ticket ID as input, and tracks/audits the
 run. Agents fetch everything else they need via our MCP server.
---
## 2. What humans still do
Humans move from producing to deciding. Remaining activities the product supports:
| Human activity | How the product supports it |
|---|---|
| Choosing what to build | Projects, ranked backlog, complexity, cost estimates |
| Defining done (when the team wants it) | Optional acceptance criteria; interview/sco
ping via Cursor Automation |
| Taste (visual, API ergonomics) | Optional visual/interface confirmation gates — only
 if the project enables them |
| Architecture & tradeoffs | Plan-stage review; decision cards with options |
| Risk acceptance | Risk labels, mandatory human gates defined per project |
| Verifying intent | Attention inbox with evidence from stage reports; Cursor owns cod
e review |
| Answering agent questions | Blocking question protocol with one-click resume |
