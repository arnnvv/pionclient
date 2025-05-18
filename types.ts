export interface SignalingMessage {
  type: string;
  payload: any;
  fromPeerID?: string;
  toPeerID?: string;
}

export interface SDPPayload {
  sdp: RTCSessionDescriptionInit;
}

export interface CandidatePayload {
  candidate: RTCIceCandidateInit;
}

export interface DirectSignalPayload {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  toPeerID: string;
}

export interface SignalInitiateP2PClientPayload {
  clientId: string;
}

export interface P2PMessagePayloadFromServer {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  fromPeerID: string;
  toPeerID?: string;
  clientId?: string;
}

export type ReceivedSignalingMessage =
  | { type: "answer"; payload: SDPPayload }
  | { type: "candidate"; payload: CandidatePayload }
  | { type: "signal-initiate-p2p"; payload: P2PMessagePayloadFromServer }
  | { type: "direct-offer"; payload: P2PMessagePayloadFromServer }
  | { type: "direct-answer"; payload: P2PMessagePayloadFromServer }
  | { type: "direct-candidate"; payload: P2PMessagePayloadFromServer }
  | { type: string; payload: any };
