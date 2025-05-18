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
  fromPeerID?: string;
}
