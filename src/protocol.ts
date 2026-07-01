/**
 * Wire protocol shared by the client and every server implementation.
 *
 * Two categories of messages travel over the single control-plane WebSocket:
 *
 *  - Signaling — WebRTC SDP/ICE relayed verbatim between peers. The server
 *    never inspects `signal.data`; all authorization is implicit in knowing
 *    the room id (and therefore the party key).
 *  - Manifest — the append-only, end-to-end-encrypted index of what photos
 *    exist in the party.
 */

/** A single entry in the party's append-only encrypted photo index. */
export interface ManifestEntry {
  /** SHA-256(ciphertext), hex — the id and membership key. */
  hash: string;
  /** Pseudonymous peer id of the uploader (not PII). */
  owner: string;
  /** Ciphertext byte length. */
  size: number;
  /** `encryptString(K, filename)`. */
  encName: string;
  /** Small encrypted thumbnail (base64url) for the instant grid. */
  encThumb: string;
  /** Epoch millis the entry was added. */
  addedAt: number;
}

// --- client -> server -------------------------------------------------------

/** Join a room; server replies with the peer list and current manifest. */
export interface JoinMessage {
  t: "join";
  peerId: string;
}

/** Relay a signaling payload (SDP/ICE) to another peer verbatim. */
export interface SignalMessage {
  t: "signal";
  to: string;
  from: string;
  data: unknown;
}

/** Append an entry to the manifest; server persists then broadcasts it. */
export interface ManifestAddMessage {
  t: "manifest-add";
  entry: ManifestEntry;
}

export type ClientMessage = JoinMessage | SignalMessage | ManifestAddMessage;

// --- server -> client -------------------------------------------------------

/** Reply to {@link JoinMessage}: current peers and the full manifest so far. */
export interface WelcomeMessage {
  t: "welcome";
  peers: string[];
  manifest: ManifestEntry[];
}

/** A single newly-appended manifest entry, fanned out to the room. */
export interface ManifestEntryMessage {
  t: "manifest-entry";
  entry: ManifestEntry;
}

/** Presence: a peer joined or left the room. */
export interface PeerPresenceMessage {
  t: "peer-join" | "peer-leave";
  peerId: string;
}

export type ServerMessage =
  | WelcomeMessage
  | SignalMessage
  | ManifestEntryMessage
  | PeerPresenceMessage;

export type AnyMessage = ClientMessage | ServerMessage;
