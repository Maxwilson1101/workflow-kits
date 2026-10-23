module bounded_counter {
  var count: int
  var log: List[int]

  pure def limit = 3

  action init = all {
    count' = 0,
    log' = [],
  }

  action step = all {
    count < limit,
    count' = count + 1,
    log' = log.append(count),
  }

  action reset = all {
    count == limit,
    count' = 0,
    log' = [],
  }

  action next = any {
    step,
    reset,
  }

  val reached = count == limit
}