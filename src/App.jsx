import { useState, useRef, useEffect } from "react";

const LIVE_SYSTEM = `You are Maverick, an elite poker coach with 20+ years of professional experience. You've coached WSOP champions and high-stakes grinders. You speak like a seasoned pro — direct, confident, occasionally dry humor, never condescending. You know the math cold but you explain it in plain English.

The player is multi-tabling (Table 1 and Table 2). They reference players as "T1 S3" (Table 1, Seat 3) etc.

Key principles:
- Keep responses concise — the player is mid-session managing two tables
- When they describe a villain's tendencies, give concrete exploitative adjustments immediately
- If they describe a hand situation, probe their thinking before giving your take
- Be a coach, not a solver — help them develop instincts
- Always reference which table/seat when discussing specific players

Format: 3-5 sentences max. Be punchy.`;

const REVIEW_SYSTEM = `You are Maverick, an elite poker coach with 20+ years of professional experience. You are doing a detailed post-session review with the player.

Be thorough, analytical, and educational. Reference specific hands by number when discussing them. Help the player understand the WHY behind every decision, not just what was right or wrong.

When analyzing hands:
- Break down each street: preflop, flop, turn, river
- Discuss pot odds, equity, ranges
- Point out timing tells and bet sizing patterns
- Identify emotional/tilt-influenced decisions
- Give concrete adjustments for future spots`;

const SUMMARY_PROMPT = `You are analyzing a GGPoker hand history export. Give a concise session summary in this exact JSON format, no other text:
{
  "handsPlayed": <number>,
  "flaggedHands": [
    {"index": <hand number 1-based>, "id": "<hand ID>", "reason": "<one line why this hand is interesting/problematic>"},
    ...up to 6 hands max
  ],
  "leaks": ["<leak 1>", "<leak 2>", "<leak 3>"],
  "positives": ["<positive 1>", "<positive 2>"],
  "oneLiner": "<one punchy sentence overall take on the session>"
}

Flag hands that show: big mistakes, interesting spots, close decisions, unusual villain behavior, tilt indicators, or strong plays worth reinforcing. Return ONLY the JSON.`;

const EXTRACT_PROMPT = `Extract any player observation from this message. Return JSON only, no other text.
Format: {"table": "T1" or "T2", "seat": "S1"-"S9", "notes": "brief observation"}
Only return JSON if there is a clear player read/observation. If none, return null.`;

// Truncate hand history to avoid token limits — keep first N chars
const MAX_HISTORY_CHARS = 80000;

export default function PokerCoach() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(true);
  const [tableNotes, setTableNotes] = useState({ T1: {}, T2: {} });
  const [showNotes, setShowNotes] = useState(false);
  const [activeNotesTab, setActiveNotesTab] = useState("T1");
  const [sessionMode, setSessionMode] = useState("live");
  const [expandedSeats, setExpandedSeats] = useState({});

  // Review mode state
  const [handHistory, setHandHistory] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [parsedHands, setParsedHands] = useState([]);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [currentHandIdx, setCurrentHandIdx] = useState(null);
  const [reviewPhase, setReviewPhase] = useState("upload"); // upload | summary | hand | chat
  const [dragOver, setDragOver] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Parse hand history into individual hands
  const parseHands = (text) => {
    const hands = text.split(/(?=Poker Hand #)/g).filter(h => h.trim().length > 50);
    return hands;
  };

  const getHandId = (handText) => {
    const match = handText.match(/Poker Hand #([^\s:]+)/);
    return match ? match[1] : "Unknown";
  };

  const handleFileUpload = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const hands = parseHands(text);
      setHandHistory(text.slice(0, MAX_HISTORY_CHARS));
      setParsedHands(hands);
      setFileName(file.name);
      setSessionSummary(null);
      setMessages([]);
      setReviewPhase("ready");
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const runSessionSummary = async () => {
    if (!handHistory || !apiKey) return;
    setSummaryLoading(true);
    setReviewPhase("summary");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `${SUMMARY_PROMPT}\n\nHand History:\n${handHistory}`
          }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text?.trim();
      try {
        const clean = text.replace(/```json|```/g, "").trim();
        const summary = JSON.parse(clean);
        setSessionSummary(summary);
      } catch (e) {
        setSessionSummary({ error: true, raw: text });
      }
    } catch (e) {
      setSessionSummary({ error: true, raw: "Failed to analyze session." });
    }
    setSummaryLoading(false);
  };

  const openHand = async (flaggedHand) => {
    // Find matching hand text
    const handText = parsedHands.find(h => h.includes(flaggedHand.id)) || parsedHands[flaggedHand.index - 1] || "";
    setCurrentHandIdx(flaggedHand.index);
    setReviewPhase("hand");
    setMessages([]);
    setLoading(true);

    const initMsg = {
      role: "user",
      content: `Let's review this hand. Walk me through it street by street.\n\n${handText}`
    };
    setMessages([initMsg]);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: REVIEW_SYSTEM,
          messages: [initMsg]
        })
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text || "Something went wrong.";
      setMessages([initMsg, { role: "assistant", content: reply }]);
    } catch (e) {
      setMessages([initMsg, { role: "assistant", content: "Connection error." }]);
    }
    setLoading(false);
  };

  const extractPlayerNotes = async (userMessage) => {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 200,
          messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\nMessage: "${userMessage}"` }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text?.trim();
      if (text && text !== "null") {
        const note = JSON.parse(text);
        if (note?.table && note?.seat && note?.notes) {
          const table = note.table.toUpperCase();
          const seat = note.seat.toUpperCase();
          if (table === "T1" || table === "T2") {
            setTableNotes(prev => ({ ...prev, [table]: { ...prev[table], [seat]: [...(prev[table][seat] || []), note.notes] } }));
          }
        }
      }
    } catch (e) {}
  };

  const buildContext = () => {
    const t1 = tableNotes.T1, t2 = tableNotes.T2;
    const hasT1 = Object.keys(t1).length > 0, hasT2 = Object.keys(t2).length > 0;
    if (!hasT1 && !hasT2) return "";
    let ctx = "\n\n[TABLE READS]";
    if (hasT1) ctx += "\nTable 1: " + Object.entries(t1).map(([s, n]) => `${s}: ${n.join("; ")}`).join(" | ");
    if (hasT2) ctx += "\nTable 2: " + Object.entries(t2).map(([s, n]) => `${s}: ${n.join("; ")}`).join(" | ");
    return ctx;
  };

  const totalNotes = Object.keys(tableNotes.T1).length + Object.keys(tableNotes.T2).length;

  const sendMessage = async () => {
    if (!input.trim() || !apiKey || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "44px";
    setLoading(true);

    if (sessionMode === "live") extractPlayerNotes(input.trim());

    try {
      const isReview = sessionMode === "review";
      const system = isReview ? REVIEW_SYSTEM : (LIVE_SYSTEM + buildContext() + "\n\nThe player is in a LIVE SESSION managing two tables. Keep it tight.");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system,
          messages: newMessages.map(m => ({ role: m.role, content: m.content }))
        })
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text || "Something went wrong.";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: "Connection error. Check your API key." }]);
    }
    setLoading(false);
  };

  const handleKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  const clearTable = (t) => setTableNotes(prev => ({ ...prev, [t]: {} }));
  const clearSession = () => { setMessages([]); setTableNotes({ T1: {}, T2: {} }); };
  const toggleSeat = (key) => setExpandedSeats(prev => ({ ...prev, [key]: !prev[key] }));
  const removeNote = (table, seat, idx) => {
    setTableNotes(prev => {
      const notes = [...(prev[table][seat] || [])]; notes.splice(idx, 1);
      const updated = { ...prev[table] };
      if (notes.length === 0) delete updated[seat]; else updated[seat] = notes;
      return { ...prev, [table]: updated };
    });
  };

  // ─── API Key Screen ───────────────────────────────────────────────────────
  if (showKeyInput) {
    return (
      <div style={{ minHeight: "100vh", background: "#0a0f0a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Georgia', serif", padding: "24px" }}>
        <div style={{ background: "#111811", border: "1px solid #2a3d2a", borderRadius: "16px", padding: "40px", maxWidth: "440px", width: "100%", boxShadow: "0 0 60px rgba(34,197,94,0.08)" }}>
          <div style={{ textAlign: "center", marginBottom: "32px" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px" }}>♠</div>
            <h1 style={{ color: "#e8f5e8", fontSize: "28px", margin: 0, fontWeight: "normal", letterSpacing: "2px" }}>MAVERICK</h1>
            <p style={{ color: "#4a6b4a", fontSize: "13px", margin: "8px 0 0", letterSpacing: "1px" }}>YOUR POKER COACH · 2 TABLES</p>
          </div>
          <p style={{ color: "#6b8f6b", fontSize: "14px", marginBottom: "20px", lineHeight: 1.6 }}>Enter your Anthropic API key to get started. Your key stays in this session only and is never stored.</p>
          <input type="password" placeholder="sk-ant-..." value={apiKey} onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && apiKey.startsWith("sk-") && setShowKeyInput(false)}
            style={{ width: "100%", padding: "14px 16px", background: "#0d150d", border: "1px solid #2a3d2a", borderRadius: "10px", color: "#c8e6c8", fontSize: "14px", fontFamily: "monospace", outline: "none", boxSizing: "border-box", marginBottom: "16px" }}
          />
          <button onClick={() => apiKey.startsWith("sk-") && setShowKeyInput(false)} disabled={!apiKey.startsWith("sk-")}
            style={{ width: "100%", padding: "14px", background: apiKey.startsWith("sk-") ? "#1a4d1a" : "#111", border: "1px solid " + (apiKey.startsWith("sk-") ? "#22c55e" : "#2a2a2a"), borderRadius: "10px", color: apiKey.startsWith("sk-") ? "#22c55e" : "#444", fontSize: "15px", cursor: apiKey.startsWith("sk-") ? "pointer" : "not-allowed", letterSpacing: "1px" }}>
            SIT DOWN →
          </button>
          <p style={{ color: "#3a5a3a", fontSize: "12px", marginTop: "16px", textAlign: "center" }}>Get a key at console.anthropic.com</p>
        </div>
      </div>
    );
  }

  const activeNotes = tableNotes[activeNotesTab];

  // ─── Review Mode: Upload / Summary / Hand screens ─────────────────────────
  const renderReviewContent = () => {

    // Upload screen
    if (reviewPhase === "upload" || !handHistory) {
      return (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: "480px", width: "100%", textAlign: "center" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px", opacity: 0.3 }}>♦</div>
            <p style={{ color: "#4a6b4a", fontSize: "14px", marginBottom: "24px", lineHeight: 1.7 }}>
              Upload your GGPoker hand history export to start the session review. Maverick will analyze every hand, flag the interesting spots, and identify your leaks.
            </p>
            <div
              onDrop={handleDrop} onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              style={{ border: "2px dashed " + (dragOver ? "#22c55e" : "#1a3d1a"), borderRadius: "14px", padding: "40px 24px", cursor: "pointer", background: dragOver ? "#0d1f0d" : "#0a0f0a", transition: "all 0.2s", marginBottom: "16px" }}
            >
              <div style={{ fontSize: "32px", marginBottom: "12px" }}>📂</div>
              <div style={{ color: dragOver ? "#22c55e" : "#3a6b3a", fontSize: "14px", letterSpacing: "1px" }}>
                {dragOver ? "DROP IT" : "TAP TO UPLOAD OR DRAG FILE HERE"}
              </div>
              <div style={{ color: "#2a4a2a", fontSize: "12px", marginTop: "8px" }}>.txt hand history from GGPoker / PokerCraft</div>
            </div>
            <input ref={fileInputRef} type="file" accept=".txt,.log" style={{ display: "none" }}
              onChange={e => handleFileUpload(e.target.files[0])} />
            <button onClick={() => { setReviewPhase("chat"); }}
              style={{ padding: "10px 20px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: "#3a5a3a", fontSize: "12px", cursor: "pointer", letterSpacing: "1px" }}>
              SKIP — JUST CHAT WITH MAVERICK
            </button>
          </div>
        </div>
      );
    }

    // File loaded, ready to analyze
    if (reviewPhase === "ready") {
      return (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: "480px", width: "100%", textAlign: "center" }}>
            <div style={{ background: "#0d1f0d", border: "1px solid #1a3d1a", borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
              <div style={{ color: "#22c55e", fontSize: "12px", letterSpacing: "2px", marginBottom: "8px" }}>FILE LOADED</div>
              <div style={{ color: "#c8e6c8", fontSize: "15px", marginBottom: "4px" }}>{fileName}</div>
              <div style={{ color: "#4a8a4a", fontSize: "13px" }}>{parsedHands.length} hands detected</div>
            </div>
            <button onClick={runSessionSummary}
              style={{ width: "100%", padding: "16px", background: "#1a4d1a", border: "1px solid #22c55e", borderRadius: "12px", color: "#22c55e", fontSize: "15px", cursor: "pointer", letterSpacing: "1px", marginBottom: "12px" }}>
              ANALYZE SESSION →
            </button>
            <button onClick={() => { setReviewPhase("chat"); setMessages([]); }}
              style={{ width: "100%", padding: "12px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "12px", color: "#3a6b3a", fontSize: "13px", cursor: "pointer", letterSpacing: "1px" }}>
              SKIP SUMMARY — JUST CHAT
            </button>
          </div>
        </div>
      );
    }

    // Summary loading
    if (reviewPhase === "summary" && summaryLoading) {
      return (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", gap: "8px", justifyContent: "center", marginBottom: "20px" }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22c55e", animation: "pulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
              ))}
            </div>
            <div style={{ color: "#4a8a4a", fontSize: "13px", letterSpacing: "2px" }}>MAVERICK IS REVIEWING YOUR SESSION...</div>
          </div>
        </div>
      );
    }

    // Summary screen
    if (reviewPhase === "summary" && sessionSummary && !summaryLoading) {
      if (sessionSummary.error) {
        return (
          <div style={{ flex: 1, padding: "24px" }}>
            <div style={{ color: "#c87a7a", fontSize: "14px" }}>Could not parse summary. {sessionSummary.raw}</div>
          </div>
        );
      }
      return (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          {/* One liner */}
          <div style={{ background: "#0d1f0d", border: "1px solid #1a3d1a", borderRadius: "12px", padding: "16px 20px", marginBottom: "16px" }}>
            <div style={{ color: "#22c55e", fontSize: "11px", letterSpacing: "2px", marginBottom: "8px" }}>MAVERICK'S TAKE</div>
            <div style={{ color: "#c8e6c8", fontSize: "16px", lineHeight: 1.6, fontStyle: "italic" }}>"{sessionSummary.oneLiner}"</div>
            <div style={{ color: "#3a6b3a", fontSize: "12px", marginTop: "10px" }}>{sessionSummary.handsPlayed} hands played · {fileName}</div>
          </div>

          {/* Leaks */}
          {sessionSummary.leaks?.length > 0 && (
            <div style={{ background: "#1a0d0d", border: "1px solid #3d1a1a", borderRadius: "12px", padding: "16px 20px", marginBottom: "16px" }}>
              <div style={{ color: "#c87a7a", fontSize: "11px", letterSpacing: "2px", marginBottom: "10px" }}>⚠ LEAKS DETECTED</div>
              {sessionSummary.leaks.map((leak, i) => (
                <div key={i} style={{ color: "#d4a0a0", fontSize: "14px", paddingLeft: "12px", borderLeft: "2px solid #3d1a1a", marginBottom: "8px", lineHeight: 1.5 }}>{leak}</div>
              ))}
            </div>
          )}

          {/* Positives */}
          {sessionSummary.positives?.length > 0 && (
            <div style={{ background: "#0d1a0d", border: "1px solid #1a3d1a", borderRadius: "12px", padding: "16px 20px", marginBottom: "16px" }}>
              <div style={{ color: "#22c55e", fontSize: "11px", letterSpacing: "2px", marginBottom: "10px" }}>✓ PLAYING WELL</div>
              {sessionSummary.positives.map((pos, i) => (
                <div key={i} style={{ color: "#7aad7a", fontSize: "14px", paddingLeft: "12px", borderLeft: "2px solid #1a3d1a", marginBottom: "8px", lineHeight: 1.5 }}>{pos}</div>
              ))}
            </div>
          )}

          {/* Flagged hands */}
          {sessionSummary.flaggedHands?.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ color: "#4a8a4a", fontSize: "11px", letterSpacing: "2px", marginBottom: "10px" }}>HANDS TO REVIEW</div>
              {sessionSummary.flaggedHands.map((hand, i) => (
                <button key={i} onClick={() => openHand(hand)}
                  style={{ width: "100%", padding: "14px 16px", background: "#0d150d", border: "1px solid #1a2d1a", borderRadius: "10px", marginBottom: "8px", cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "all 0.15s" }}
                  onMouseOver={e => e.currentTarget.style.borderColor = "#2a5a2a"}
                  onMouseOut={e => e.currentTarget.style.borderColor = "#1a2d1a"}
                >
                  <div>
                    <div style={{ color: "#22c55e", fontSize: "12px", letterSpacing: "1px", marginBottom: "4px" }}>HAND #{hand.index} · {hand.id}</div>
                    <div style={{ color: "#7aad7a", fontSize: "13px" }}>{hand.reason}</div>
                  </div>
                  <div style={{ color: "#3a6b3a", fontSize: "18px", flexShrink: 0 }}>→</div>
                </button>
              ))}
            </div>
          )}

          <button onClick={() => { setReviewPhase("chat"); setMessages([]); }}
            style={{ width: "100%", padding: "12px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "10px", color: "#3a6b3a", fontSize: "13px", cursor: "pointer", letterSpacing: "1px" }}>
            OPEN CHAT — ASK MAVERICK ANYTHING
          </button>
          <div style={{ height: "20px" }} />
        </div>
      );
    }

    // Hand review or free chat — falls through to main chat render below
    return null;
  };

  // ─── Main Layout ──────────────────────────────────────────────────────────
  const isReviewChat = sessionMode === "review" && (reviewPhase === "hand" || reviewPhase === "chat");
  const showChat = sessionMode === "live" || isReviewChat;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f0a", display: "flex", flexDirection: "column", fontFamily: "'Georgia', serif", maxWidth: "800px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ padding: "14px 16px", borderBottom: "1px solid #1a2d1a", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0d150d", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "20px" }}>♠</span>
          <div>
            <div style={{ color: "#c8e6c8", fontSize: "15px", letterSpacing: "2px" }}>MAVERICK</div>
            <div style={{ color: "#3a6b3a", fontSize: "10px", letterSpacing: "1px" }}>POKER COACH</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
          <div style={{ display: "flex", background: "#0a0f0a", border: "1px solid #1a2d1a", borderRadius: "8px", overflow: "hidden" }}>
            {["live", "review"].map(mode => (
              <button key={mode} onClick={() => { setSessionMode(mode); if (mode === "review" && !handHistory) setReviewPhase("upload"); }}
                style={{ padding: "5px 10px", background: sessionMode === mode ? "#1a3d1a" : "transparent", border: "none", color: sessionMode === mode ? "#22c55e" : "#4a6b4a", fontSize: "10px", cursor: "pointer", letterSpacing: "1px", textTransform: "uppercase" }}>
                {mode}
              </button>
            ))}
          </div>
          {sessionMode === "live" && (
            <button onClick={() => setShowNotes(!showNotes)}
              style={{ padding: "5px 10px", background: showNotes ? "#1a3d1a" : "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: totalNotes > 0 ? "#22c55e" : "#4a6b4a", fontSize: "10px", cursor: "pointer", letterSpacing: "1px" }}>
              READS {totalNotes > 0 ? `(${totalNotes})` : ""}
            </button>
          )}
          {sessionMode === "review" && handHistory && (reviewPhase === "hand" || reviewPhase === "chat" || reviewPhase === "summary") && (
            <button onClick={() => { setReviewPhase("summary"); setMessages([]); }}
              style={{ padding: "5px 10px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: "#4a6b4a", fontSize: "10px", cursor: "pointer", letterSpacing: "1px" }}>
              ← SUMMARY
            </button>
          )}
          {sessionMode === "review" && (
            <button onClick={() => { setHandHistory(null); setFileName(null); setParsedHands([]); setSessionSummary(null); setReviewPhase("upload"); setMessages([]); }}
              style={{ padding: "5px 10px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: "#4a5a4a", fontSize: "10px", cursor: "pointer", letterSpacing: "1px" }}>
              NEW FILE
            </button>
          )}
          {sessionMode === "live" && (
            <button onClick={clearSession}
              style={{ padding: "5px 10px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: "#4a5a4a", fontSize: "10px", cursor: "pointer", letterSpacing: "1px" }}>
              NEW
            </button>
          )}
        </div>
      </div>

      {/* Live: Notes panel */}
      {sessionMode === "live" && showNotes && (
        <div style={{ background: "#0d1a0d", borderBottom: "1px solid #1a2d1a" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #1a2d1a" }}>
            {["T1", "T2"].map(t => {
              const count = Object.keys(tableNotes[t]).length;
              return (
                <button key={t} onClick={() => setActiveNotesTab(t)}
                  style={{ flex: 1, padding: "10px", background: activeNotesTab === t ? "#111d11" : "transparent", border: "none", borderBottom: activeNotesTab === t ? "2px solid #22c55e" : "2px solid transparent", color: activeNotesTab === t ? "#22c55e" : "#4a6b4a", fontSize: "12px", cursor: "pointer", letterSpacing: "2px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                  TABLE {t[1]}
                  {count > 0 && <span style={{ background: "#1a3d1a", color: "#22c55e", fontSize: "10px", padding: "1px 6px", borderRadius: "10px" }}>{count}</span>}
                </button>
              );
            })}
          </div>
          <div style={{ padding: "14px 16px" }}>
            {Object.keys(activeNotes).length === 0 ? (
              <div style={{ color: "#3a5a3a", fontSize: "13px", textAlign: "center", padding: "8px 0" }}>
                No reads on Table {activeNotesTab[1]} yet.<br />
                <span style={{ fontSize: "12px", color: "#2a4a2a" }}>Try: "T{activeNotesTab[1]} S3 limps every hand, won't fold preflop"</span>
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "10px" }}>
                  {Object.entries(activeNotes).sort(([a], [b]) => a.localeCompare(b)).map(([seat, notes]) => {
                    const key = `${activeNotesTab}-${seat}`;
                    const expanded = expandedSeats[key];
                    return (
                      <div key={seat} style={{ background: "#0a0f0a", border: "1px solid #1a2d1a", borderRadius: "8px", overflow: "hidden" }}>
                        <div onClick={() => toggleSeat(key)} style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
                          <span style={{ color: "#22c55e", fontSize: "12px", letterSpacing: "1px", fontWeight: "bold" }}>{seat}</span>
                          <span style={{ color: "#3a6b3a", fontSize: "11px" }}>{notes.length} read{notes.length !== 1 ? "s" : ""} {expanded ? "▲" : "▼"}</span>
                        </div>
                        {expanded && (
                          <div style={{ borderTop: "1px solid #1a2d1a", padding: "8px 12px" }}>
                            {notes.map((note, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px", gap: "6px" }}>
                                <div style={{ color: "#7aad7a", fontSize: "12px", lineHeight: 1.4, borderLeft: "2px solid #1a3d1a", paddingLeft: "8px", flex: 1 }}>{note}</div>
                                <button onClick={() => removeNote(activeNotesTab, seat, i)} style={{ background: "none", border: "none", color: "#3a5a3a", fontSize: "14px", cursor: "pointer", padding: "0", flexShrink: 0 }}>×</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button onClick={() => clearTable(activeNotesTab)} style={{ width: "100%", padding: "7px", background: "transparent", border: "1px solid #2a1a1a", borderRadius: "6px", color: "#6b3a3a", fontSize: "11px", cursor: "pointer", letterSpacing: "1px" }}>
                  CLEAR TABLE {activeNotesTab[1]} (SESSION OVER)
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Live: Table status bar */}
      {sessionMode === "live" && (
        <div style={{ display: "flex", borderBottom: "1px solid #111d11", background: "#0a0d0a" }}>
          {["T1", "T2"].map(t => {
            const count = Object.keys(tableNotes[t]).length;
            return (
              <div key={t} style={{ flex: 1, padding: "5px 12px", display: "flex", alignItems: "center", gap: "6px", borderRight: t === "T1" ? "1px solid #111d11" : "none" }}>
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: count > 0 ? "#22c55e" : "#1a3d1a" }} />
                <span style={{ color: "#3a6b3a", fontSize: "10px", letterSpacing: "1px" }}>TABLE {t[1]}</span>
                {count > 0 && <span style={{ color: "#4a8a4a", fontSize: "10px" }}>· {count} tracked</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Review mode: non-chat screens */}
      {sessionMode === "review" && !isReviewChat && renderReviewContent()}

      {/* Chat area — live mode OR review hand/chat */}
      {showChat && (
        <>
          <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
            {/* Review hand header */}
            {sessionMode === "review" && reviewPhase === "hand" && currentHandIdx && (
              <div style={{ background: "#0d1a0d", border: "1px solid #1a3d1a", borderRadius: "10px", padding: "10px 16px", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#22c55e", fontSize: "12px", letterSpacing: "1px" }}>REVIEWING HAND #{currentHandIdx}</span>
                <button onClick={() => { setReviewPhase("summary"); setMessages([]); }}
                  style={{ background: "none", border: "none", color: "#4a8a4a", fontSize: "12px", cursor: "pointer", letterSpacing: "1px" }}>← BACK TO SUMMARY</button>
              </div>
            )}

            {messages.length === 0 && (
              <div style={{ textAlign: "center", paddingTop: "40px" }}>
                <div style={{ fontSize: "44px", marginBottom: "16px", opacity: 0.2 }}>♦</div>
                <p style={{ color: "#2a4a2a", fontSize: "14px", lineHeight: 1.8, maxWidth: "380px", margin: "0 auto" }}>
                  {sessionMode === "live"
                    ? "Two tables running. Between hands — describe a player or spot. Use T1/T2 + seat number."
                    : "Ask Maverick anything about your session, specific hands, or general strategy."}
                </p>
                <div style={{ marginTop: "24px", display: "flex", flexDirection: "column", gap: "8px", maxWidth: "360px", margin: "24px auto 0" }}>
                  {(sessionMode === "live" ? [
                    "T1 S4 limps everything and won't fold preflop",
                    "T2 S7 has 3bet me 3 times, what's my strategy?",
                    "T1 S2 is a calling station, how do I adjust?",
                    "Both tables are playing tight, should I steal more?"
                  ] : [
                    "What was my biggest leak this session?",
                    "Walk me through a tough spot I had",
                    "How do I play better against aggressive 3-bettors?"
                  ]).map((prompt, i) => (
                    <button key={i} onClick={() => setInput(prompt)}
                      style={{ padding: "9px 14px", background: "transparent", border: "1px solid #1a2d1a", borderRadius: "8px", color: "#3a6b3a", fontSize: "13px", cursor: "pointer", textAlign: "left" }}
                      onMouseOver={e => e.currentTarget.style.borderColor = "#2a5a2a"}
                      onMouseOut={e => e.currentTarget.style.borderColor = "#1a2d1a"}
                    >{prompt}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{ marginBottom: "18px", display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                {msg.role === "assistant" && <div style={{ color: "#22c55e", fontSize: "10px", letterSpacing: "2px", marginBottom: "5px", paddingLeft: "4px" }}>MAVERICK</div>}
                <div style={{ maxWidth: "88%", padding: "12px 16px", borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "4px 16px 16px 16px", background: msg.role === "user" ? "#0d1f0d" : "#111d11", border: "1px solid " + (msg.role === "user" ? "#1a3d1a" : "#1e3d1e"), color: msg.role === "user" ? "#8ab88a" : "#c8e6c8", fontSize: "15px", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "18px" }}>
                <div style={{ padding: "12px 16px", borderRadius: "4px 16px 16px 16px", background: "#111d11", border: "1px solid #1e3d1e" }}>
                  <div style={{ display: "flex", gap: "5px" }}>
                    {[0, 1, 2].map(i => <div key={i} style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", animation: "pulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s`, opacity: 0.6 }} />)}
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: "14px 16px", borderTop: "1px solid #1a2d1a", background: "#0d150d", position: "sticky", bottom: 0 }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
              <textarea ref={textareaRef} value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
                onKeyDown={handleKey}
                placeholder={sessionMode === "live" ? "e.g. T1 S3 limps everything... or T2 should I call this river?" : "Ask Maverick about this hand or your session..."}
                rows={1}
                style={{ flex: 1, padding: "12px 14px", background: "#0a0f0a", border: "1px solid #1a2d1a", borderRadius: "12px", color: "#c8e6c8", fontSize: "15px", fontFamily: "'Georgia', serif", resize: "none", outline: "none", lineHeight: 1.5, minHeight: "44px", maxHeight: "120px", overflowY: "auto" }}
              />
              <button onClick={sendMessage} disabled={!input.trim() || loading}
                style={{ padding: "12px 18px", background: input.trim() && !loading ? "#1a4d1a" : "#0d150d", border: "1px solid " + (input.trim() && !loading ? "#22c55e" : "#1a2d1a"), borderRadius: "12px", color: input.trim() && !loading ? "#22c55e" : "#2a4a2a", fontSize: "18px", cursor: input.trim() && !loading ? "pointer" : "not-allowed", transition: "all 0.15s", flexShrink: 0 }}>▲</button>
            </div>
            <div style={{ color: "#2a4a2a", fontSize: "10px", marginTop: "7px", letterSpacing: "1px", textAlign: "center" }}>
              {sessionMode === "live" ? "● LIVE · USE T1/T2 + SEAT TO REFERENCE PLAYERS" : "● REVIEW · MAVERICK HAS YOUR FULL SESSION CONTEXT"}
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0f0a; }
        ::-webkit-scrollbar-thumb { background: #1a3d1a; border-radius: 2px; }
      `}</style>
    </div>
  );
}
