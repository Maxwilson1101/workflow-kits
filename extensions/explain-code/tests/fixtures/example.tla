---------------- MODULE Channel ----------------
EXTENDS Naturals, Sequences

CONSTANT Capacity

VARIABLES queue, sent, acked

TypeInvariant ==
    /\ queue \in Seq(1..Capacity)
    /\ sent \in Nat
    /\ acked \in Nat
    /\ acked <= sent

Init ==
    /\ queue = <<>>
    /\ sent = 0
    /\ acked = 0

Send(item) ==
    /\ Len(queue) < Capacity
    /\ queue' = Append(queue, item)
    /\ sent' = sent + 1
    /\ acked' = acked

Ack ==
    /\ Len(queue) > 0
    /\ queue' = Tail(queue)
    /\ acked' = acked + 1
    /\ sent' = sent

Next ==
    \/ \E item \in 1..Capacity: Send(item)
    \/ Ack

(*--algorithm receiver
variables
  buffer = <<>>;
  delivered = 0;
begin
  while delivered < Capacity do
    either
      buffer := Append(buffer, delivered);
      delivered := delivered + 1;
    or
      await buffer /= <<>>;
      buffer := Tail(buffer);
    end either;
  end while;
end algorithm; *)

Spec == Init /\ [][Next]_<<queue, sent, acked>>
================================================