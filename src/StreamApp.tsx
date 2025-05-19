import { useEffect, useRef, useState, type JSX } from "react";
import type {
  CandidatePayload,
  DirectSignalPayload,
  SDPPayload,
  SignalingMessage,
} from "./../types";
import { v4 } from "./../uuid";

const WS_URL_BASE = "ws://localhost:8080/ws/stream";

export function StreamApp(): JSX.Element {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [clientId] = useState<string>(() => v4());
  const ws = useRef<WebSocket | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);

  const serverPc = useRef<RTCPeerConnection | null>(null);
  const serverPcSenders = useRef<Map<string, RTCRtpSender>>(new Map());
  const pendingServerCandidates = useRef<RTCIceCandidateInit[]>([]);

  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [displayedRemoteStreams, setDisplayedRemoteStreams] = useState<
    Map<string, MediaStream>
  >(new Map());
  const pendingP2PCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map(),
  );

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement | null>>(
    new Map(),
  );

  const sendSignalingMessage = (message: SignalingMessage) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[StreamApp] Sending signaling message:", message);
      ws.current.send(JSON.stringify(message));
    } else {
      console.warn(
        "[StreamApp] WebSocket not open, cannot send message:",
        message,
      );
    }
  };

  const createServerPeerConnection = (): RTCPeerConnection => {
    console.log("[StreamApp] createServerPeerConnection called");
    if (serverPc.current && serverPc.current.signalingState !== "closed") {
      console.log("[StreamApp] Returning existing serverPc");
      return serverPc.current;
    }
    console.log("[StreamApp] Creating NEW serverPc (HLS PC)");
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[StreamApp] serverPc ICE candidate:", event.candidate);
        sendSignalingMessage({
          type: "candidate",
          payload: { candidate: event.candidate.toJSON() } as CandidatePayload,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        "[StreamApp] serverPc ICE connection state change:",
        pc.iceConnectionState,
      );
      if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      ) {
        console.log(
          "[StreamApp] serverPc ICE connection failed/closed/disconnected. Cleaning up.",
        );
        serverPc.current?.close();
        serverPc.current = null;
        serverPcSenders.current.clear();
        pendingServerCandidates.current = [];
      }
    };
    serverPc.current = pc;
    return pc;
  };

  const createAndSendOfferToServerPc = async () => {
    if (!serverPc.current || serverPc.current.signalingState === "closed") {
      console.error(
        "[StreamApp] createAndSendOfferToServerPc: serverPc is null or closed.",
      );
      return;
    }
    console.log(
      "[StreamApp] createAndSendOfferToServerPc: Attempting to create offer for serverPc. Signaling state:",
      serverPc.current.signalingState,
    );

    if (
      serverPc.current.getSenders().filter((s) => s.track).length === 0 &&
      localStream
    ) {
      console.warn(
        "[StreamApp] createAndSendOfferToServerPc: No tracks on serverPc yet, but localStream exists. This might be too early or tracks not added.",
      );
    }

    try {
      const offer = await serverPc.current.createOffer();
      console.log(
        "[StreamApp] createAndSendOfferToServerPc: Offer created for serverPc:",
        offer,
      );
      await serverPc.current.setLocalDescription(offer);
      console.log(
        "[StreamApp] createAndSendOfferToServerPc: Local description set on serverPc",
      );
      sendSignalingMessage({
        type: "offer",
        payload: {
          sdp: serverPc.current.localDescription?.toJSON(),
        } as SDPPayload,
      });
      console.log(
        "[StreamApp] createAndSendOfferToServerPc: 'offer' message sent to server for serverPc",
      );
    } catch (error) {
      console.error(
        "[StreamApp] createAndSendOfferToServerPc: Error creating/sending offer for serverPc:",
        error,
      );
    }
  };

  const createP2PConnection = (peerId: string): RTCPeerConnection => {
    if (peerConnections.current.has(peerId)) {
      const p2pconnection = peerConnections.current.get(peerId);
      if (!p2pconnection)
        throw new Error("P2PConnection does not exist but was in map");
      return p2pconnection;
    }
    console.log(`[StreamApp] Creating NEW P2P connection for peer ${peerId}`);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerConnections.current.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({
          type: "direct-candidate",
          payload: {
            candidate: event.candidate.toJSON(),
            toPeerID: peerId,
          } as DirectSignalPayload,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log(
        `[StreamApp] P2P connection with ${peerId} received track:`,
        event.track,
      );
      let stream = remoteStreams.current.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.current.set(peerId, stream);
      }
      stream.addTrack(event.track);
      setDisplayedRemoteStreams((prev) => new Map(prev).set(peerId, stream!));
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        `[StreamApp] P2P connection with ${peerId} ICE state: ${pc.iceConnectionState}`,
      );
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "failed"
      ) {
        peerConnections.current.get(peerId)?.close();
        peerConnections.current.delete(peerId);
        remoteStreams.current.delete(peerId);
        pendingP2PCandidates.current.delete(peerId);
        setDisplayedRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.delete(peerId);
          return newMap;
        });
      }
    };

    if (localStream) {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: In createP2PConnection for ${peerId.substring(0, 4)}. Adding localStream tracks.`,
      );
      for (const track of localStream.getTracks()) {
        try {
          if (!pc.getSenders().find((s) => s.track === track)) {
            pc.addTrack(track, localStream);
            console.log(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Added track ${track.kind} to P2P for ${peerId.substring(0, 4)}`,
            );
          }
        } catch (e) {
          console.error(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error adding track to P2P PC for ${peerId.substring(0, 4)}:`,
            e,
          );
        }
      }
    } else {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: In createP2PConnection for ${peerId.substring(0, 4)}. LocalStream is NULL, no tracks added initially.`,
      );
    }

    pc.onnegotiationneeded = async () => {
      if (
        pc.signalingState === "stable" &&
        peerConnections.current.has(peerId) /* ensure it's still a managed PC */
      ) {
        console.log(
          `[StreamApp] CLIENT ${clientId.substring(0, 4)}: onnegotiationneeded for P2P with ${peerId.substring(0, 4)}. Creating offer.`,
        );
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignalingMessage({
            type: "direct-offer",
            payload: {
              sdp: pc.localDescription?.toJSON(),
              toPeerID: peerId,
            } as DirectSignalPayload,
          });
        } catch (e) {
          console.error(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error in P2P onnegotiationneeded for ${peerId.substring(0, 4)}:`,
            e,
          );
        }
      } else {
        console.warn(
          `[StreamApp] CLIENT ${clientId.substring(0, 4)}: onnegotiationneeded for P2P with ${peerId.substring(0, 4)} but state not stable or PC removed. State: ${pc.signalingState}`,
        );
      }
    };

    return pc;
  };

  const handleInitiateP2P = (fromPeerID: string) => {
    console.log(
      `[StreamApp] CLIENT ${clientId.substring(0, 4)}: handleInitiateP2P from NEW PEER ${fromPeerID.substring(0, 4)}`,
    );
    if (fromPeerID === clientId) return;
    if (peerConnections.current.has(fromPeerID)) {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: P2P connection with ${fromPeerID.substring(0, 4)} already exists or pending.`,
      );
      return;
    }

    const p2pPc = createP2PConnection(fromPeerID);

    if (p2pPc.getSenders().some((sender) => sender.track)) {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Tracks present on new P2P PC for ${fromPeerID.substring(0, 4)}. Creating offer.`,
      );
      p2pPc
        .createOffer()
        .then((offer) => {
          console.log(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Offer created for ${fromPeerID.substring(0, 4)}`,
          );
          return p2pPc.setLocalDescription(offer);
        })
        .then(() => {
          if (p2pPc.localDescription) {
            console.log(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Sending direct-offer to ${fromPeerID.substring(0, 4)}`,
            );
            sendSignalingMessage({
              type: "direct-offer",
              payload: {
                sdp: p2pPc.localDescription.toJSON(),
                toPeerID: fromPeerID,
              } as DirectSignalPayload,
            });
          }
        })
        .catch((e) => {
          console.error(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error in handleInitiateP2P offer for ${fromPeerID.substring(0, 4)}:`,
            e,
          );
        });
    } else {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: No tracks on new P2P PC for ${fromPeerID.substring(0, 4)} yet (localStream might be null). Offer will be triggered by onnegotiationneeded when tracks are added later.`,
      );
      p2pPc.onnegotiationneeded = async () => {
        if (p2pPc.signalingState === "stable") {
          console.log(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: onnegotiationneeded for P2P with ${fromPeerID.substring(0, 4)}. Creating offer.`,
          );
          try {
            const offer = await p2pPc.createOffer();
            await p2pPc.setLocalDescription(offer);
            sendSignalingMessage({
              type: "direct-offer",
              payload: {
                sdp: p2pPc.localDescription?.toJSON(),
                toPeerID: fromPeerID,
              } as DirectSignalPayload,
            });
          } catch (e) {
            console.error(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error in P2P onnegotiationneeded for ${fromPeerID.substring(0, 4)}:`,
              e,
            );
          }
        }
      };
    }
  };

  const handleDirectOffer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    console.log(`[StreamApp] handleDirectOffer from ${fromPeerID}`);
    if (fromPeerID === clientId) return;
    const p2pPc = createP2PConnection(fromPeerID);
    try {
      await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));

      const candidates = pendingP2PCandidates.current.get(fromPeerID);
      if (candidates) {
        for (const candidate of candidates) {
          try {
            await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error(
              `[StreamApp] Error adding pending P2P candidate from ${fromPeerID}:`,
              e,
            );
          }
        }
        pendingP2PCandidates.current.delete(fromPeerID);
      }

      const answer = await p2pPc.createAnswer();
      await p2pPc.setLocalDescription(answer);
      if (p2pPc.localDescription) {
        sendSignalingMessage({
          type: "direct-answer",
          payload: {
            sdp: p2pPc.localDescription.toJSON(),
            toPeerID: fromPeerID,
          } as DirectSignalPayload,
        });
      }
    } catch (e) {
      console.error(
        `[StreamApp] Error in handleDirectOffer from ${fromPeerID}:`,
        e,
      );
    }
  };

  const handleDirectAnswer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    console.log(`[StreamApp] handleDirectAnswer from ${fromPeerID}`);
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      try {
        await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
        const candidates = pendingP2PCandidates.current.get(fromPeerID);
        if (candidates) {
          for (const candidate of candidates) {
            try {
              await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.error(
                `[StreamApp] Error adding pending P2P candidate (on answer) from ${fromPeerID}:`,
                e,
              );
            }
          }
          pendingP2PCandidates.current.delete(fromPeerID);
        }
      } catch (e) {
        console.error(
          `[StreamApp] Error in handleDirectAnswer from ${fromPeerID}:`,
          e,
        );
      }
    }
  };

  const handleDirectCandidate = async (
    fromPeerID: string,
    candidateInit: RTCIceCandidateInit,
  ) => {
    console.log(`[StreamApp] handleDirectCandidate from ${fromPeerID}`);
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      if (p2pPc.remoteDescription && p2pPc.signalingState !== "closed") {
        try {
          await p2pPc.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch (e) {
          console.error(
            `[StreamApp] Error adding direct P2P candidate from ${fromPeerID}:`,
            e,
          );
        }
      } else {
        const peerCandidates =
          pendingP2PCandidates.current.get(fromPeerID) || [];
        peerCandidates.push(candidateInit);
        pendingP2PCandidates.current.set(fromPeerID, peerCandidates);
      }
    }
  };

  useEffect(() => {
    const wsUrlWithClientId = `${WS_URL_BASE}?clientId=${clientId}`;
    console.log(`[StreamApp] Connecting WebSocket to ${wsUrlWithClientId}`);
    const socket = new WebSocket(wsUrlWithClientId);
    ws.current = socket;

    socket.onopen = () => {
      console.log("[StreamApp] WebSocket connected.");
      setIsWsConnected(true);
      sendSignalingMessage({
        type: "signal-initiate-p2p",
        payload: { clientId: clientId },
      });
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data as string) as SignalingMessage;
        console.log("[StreamApp] WebSocket message received:", message);

        switch (message.type) {
          case "answer":
            if (
              serverPc.current &&
              message.payload.sdp &&
              serverPc.current.signalingState !== "closed"
            ) {
              console.log(
                "[StreamApp] Received 'answer' for serverPc (HLS). Setting remote description.",
              );
              await serverPc.current.setRemoteDescription(
                new RTCSessionDescription(message.payload.sdp),
              );
              if (pendingServerCandidates.current.length > 0) {
                console.log(
                  "[StreamApp] Processing pending serverPc candidates after receiving answer.",
                );
                for (const candidate of pendingServerCandidates.current) {
                  try {
                    await serverPc.current.addIceCandidate(
                      new RTCIceCandidate(candidate),
                    );
                  } catch (e) {
                    console.error(
                      "[StreamApp] Error adding pending serverPc candidate:",
                      e,
                    );
                  }
                }
                pendingServerCandidates.current = [];
              }
            }
            break;
          case "candidate":
            if (
              serverPc.current &&
              message.payload.candidate &&
              serverPc.current.signalingState !== "closed"
            ) {
              if (serverPc.current.remoteDescription) {
                console.log(
                  "[StreamApp] Received 'candidate' for serverPc (HLS), remote desc set. Adding ICE candidate.",
                );
                await serverPc.current.addIceCandidate(
                  new RTCIceCandidate(message.payload.candidate),
                );
              } else {
                console.log(
                  "[StreamApp] Received 'candidate' for serverPc (HLS), remote desc NOT set. Queuing candidate.",
                );
                pendingServerCandidates.current.push(
                  message.payload.candidate as RTCIceCandidateInit,
                );
              }
            }
            break;
          case "signal-initiate-p2p":
            if (
              message.payload.fromPeerID &&
              message.payload.fromPeerID !== clientId
            ) {
              if (!peerConnections.current.has(message.payload.fromPeerID)) {
                handleInitiateP2P(message.payload.fromPeerID);
              }
            }
            break;
          case "direct-offer":
            if (message.payload.fromPeerID && message.payload.sdp) {
              await handleDirectOffer(
                message.payload.fromPeerID,
                message.payload.sdp,
              );
            }
            break;
          case "direct-answer":
            if (message.payload.fromPeerID && message.payload.sdp) {
              await handleDirectAnswer(
                message.payload.fromPeerID,
                message.payload.sdp,
              );
            }
            break;
          case "direct-candidate":
            if (message.payload.fromPeerID && message.payload.candidate) {
              await handleDirectCandidate(
                message.payload.fromPeerID,
                message.payload.candidate,
              );
            }
            break;
          default:
            console.warn(
              "[StreamApp] Unknown WebSocket message type:",
              message.type,
            );
            break;
        }
      } catch (error) {
        console.error(
          "[StreamApp] Error processing WebSocket message:",
          error,
          "Raw data:",
          event.data,
        );
      }
    };

    socket.onerror = (err) => {
      console.error("[StreamApp] WebSocket error:", err);
      setIsWsConnected(false);
    };

    socket.onclose = (event) => {
      console.log("[StreamApp] WebSocket closed:", event.code, event.reason);
      ws.current = null;
      setIsWsConnected(false);
    };

    return () => {
      console.log(
        "[StreamApp] Cleaning up main useEffect. Closing connections.",
      );
      serverPc.current?.close();
      serverPc.current = null;
      serverPcSenders.current.clear();
      pendingServerCandidates.current = [];

      for (const [, pc] of peerConnections.current) {
        pc.close();
      }
      peerConnections.current.clear();
      remoteStreams.current.clear();
      pendingP2PCandidates.current.clear();
      setDisplayedRemoteStreams(new Map());

      if (ws.current) {
        ws.current.onopen = null;
        ws.current.onmessage = null;
        ws.current.onerror = null;
        ws.current.onclose = null;
        ws.current.close();
      }
      ws.current = null;
      setIsWsConnected(false);
      if (localStream) {
        console.log("[StreamApp] Stopping local stream tracks in cleanup.");
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        setLocalStream(null);
      }
    };
  }, [clientId]);

  const startStreaming = async () => {
    console.log("[StreamApp] startStreaming called");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log("[StreamApp] Got user media stream:", stream);
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error("[StreamApp] Could not access camera/microphone:", error);
      alert("Could not access camera/microphone. Please check permissions.");
    }
  };

  useEffect(() => {
    if (localStream && isWsConnected) {
      console.log(
        "[StreamApp] localStream and isWsConnected are true. Initiating HLS connection.",
      );
      initiateHLSConnection(localStream);
      initiateP2PConnectionsWithExistingPeers(localStream);
    }
  }, [localStream, isWsConnected]);

  const initiateHLSConnection = async (currentLocalStream: MediaStream) => {
    console.log("[StreamApp] initiateHLSConnection called");
    let sPC = serverPc.current;
    if (!sPC || sPC.signalingState === "closed") {
      sPC = createServerPeerConnection();
    }

    let tracksChangedOrAddedToHLS = false;
    for (const track of currentLocalStream.getTracks()) {
      const existingSender = serverPcSenders.current.get(track.kind);
      if (existingSender) {
        if (existingSender.track?.id !== track.id) {
          console.log(
            `[StreamApp] Replacing track ${track.kind} on serverPc (HLS)`,
          );
          await existingSender.replaceTrack(track).catch((e) => {
            console.error("Error replacing track on serverPc:", e);
          });
          tracksChangedOrAddedToHLS = true;
        }
      } else {
        try {
          console.log(
            `[StreamApp] Adding track ${track.kind} to serverPc (HLS)`,
          );
          const newSender = sPC.addTrack(track, currentLocalStream);
          serverPcSenders.current.set(track.kind, newSender);
          tracksChangedOrAddedToHLS = true;
        } catch (e) {
          console.error("[StreamApp] Error adding track to serverPc:", e);
        }
      }
    }

    if (sPC.signalingState === "stable" && tracksChangedOrAddedToHLS) {
      console.log(
        "[StreamApp] ServerPc (HLS) is stable and tracks changed/added. Creating offer.",
      );
      await createAndSendOfferToServerPc();
    } else if (sPC.signalingState !== "stable") {
      console.log(
        "[StreamApp] ServerPc (HLS) not in stable state, will rely on negotiationneeded or manual restart for offer if tracks were added to non-stable PC.",
      );
      sPC.onnegotiationneeded = async () => {
        console.log("[StreamApp] serverPc (HLS) 'onnegotiationneeded' fired.");
        if (sPC.signalingState === "stable") {
          await createAndSendOfferToServerPc();
        } else {
          console.warn(
            "[StreamApp] onnegotiationneeded on serverPc but not stable. State:",
            sPC.signalingState,
          );
        }
      };
    }
  };

  const initiateP2PConnectionsWithExistingPeers = (
    currentLocalStream: MediaStream,
  ) => {
    console.log(
      `[StreamApp] CLIENT ${clientId.substring(0, 4)}: initiateP2PConnectionsWithExistingPeers called with new localStream.`,
    );
    peerConnections.current.forEach(async (p2pPc, peerId) => {
      console.log(
        `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Updating/adding tracks for existing P2P connection with ${peerId.substring(0, 4)}`,
      );
      let p2pTracksChanged = false;
      for (const track of currentLocalStream.getTracks()) {
        const existingSender = p2pPc
          .getSenders()
          .find((s) => s.track?.kind === track.kind);
        if (existingSender) {
          if (
            existingSender.track?.id !== track.id &&
            existingSender.track !== null
          ) {
            console.log(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Replacing track ${track.kind} on P2P with ${peerId.substring(0, 4)}`,
            );
            await existingSender.replaceTrack(track).catch((e) => {
              console.error("Error replacing P2P track:", e);
            });
            p2pTracksChanged = true;
          }
        } else {
          try {
            console.log(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Adding track ${track.kind} to existing P2P with ${peerId.substring(0, 4)}`,
            );
            p2pPc.addTrack(track, currentLocalStream);
            p2pTracksChanged = true;
          } catch (e) {
            console.error(
              `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error adding track to existing P2P PC with ${peerId.substring(0, 4)}:`,
              e,
            );
          }
        }
      }
      if (p2pTracksChanged && p2pPc.signalingState === "stable") {
        console.log(
          `[StreamApp] CLIENT ${clientId.substring(0, 4)}: P2P with ${peerId.substring(0, 4)} had tracks changed & is stable. Explicitly creating offer (fallback).`,
        );
        try {
          const offer = await p2pPc.createOffer();
          await p2pPc.setLocalDescription(offer);
          sendSignalingMessage({
            type: "direct-offer",
            payload: {
              sdp: p2pPc.localDescription?.toJSON(),
              toPeerID: peerId,
            } as DirectSignalPayload,
          });
        } catch (e) {
          console.error(
            `[StreamApp] CLIENT ${clientId.substring(0, 4)}: Error in explicit P2P re-offer to ${peerId.substring(0, 4)}:`,
            e,
          );
        }
      }
    });
  };

  useEffect(() => {
    displayedRemoteStreams.forEach((stream, peerId) => {
      const videoElement = remoteVideoRefs.current.get(peerId);
      if (videoElement && videoElement.srcObject !== stream) {
        videoElement.srcObject = stream;
      }
    });
  }, [displayedRemoteStreams]);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">
        Stream Page (My ID: {clientId.substring(0, 8)})
      </h1>

      {!localStream ? (
        <button
          type="button"
          onClick={startStreaming}
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded mb-4"
        >
          Start Camera & Mic
        </button>
      ) : (
        <p className="text-green-600 mb-4">Streaming active.</p>
      )}
      <p className="text-sm text-gray-500 mb-2">
        WebSocket: {isWsConnected ? "Connected" : "Disconnected"}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <h2 className="text-xl">Your Video ({clientId.substring(0, 8)})</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full bg-gray-800 rounded aspect-video"
          />
        </div>

        {Array.from(displayedRemoteStreams.entries()).map(
          ([peerId, stream]) => (
            <div key={peerId}>
              <h2 className="text-xl">
                Remote Stream from {peerId.substring(0, 8)}
              </h2>
              <video
                ref={(el) => {
                  if (el) {
                    remoteVideoRefs.current.set(peerId, el);
                    if (el.srcObject !== stream) el.srcObject = stream;
                  } else {
                    remoteVideoRefs.current.delete(peerId);
                  }
                }}
                autoPlay
                playsInline
                className="w-full bg-gray-700 rounded aspect-video"
              />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
