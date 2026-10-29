export function startPassExpiry({ passService, heartbeat = 3000 }) {
  let timer;

  const tick = async () => {
    try {
      await passService.endExpiredPasses()
    }
    catch (err) {
      console.log(`failure to expire pass, error: ${err}`)
    }
  }

  function start() {
    if (timer) {
      return
    }

    const schedule = () => {
      timer = setTimeout(async () => {
        await tick()
        schedule()
      }, heartbeat)
      timer.unref()
    }

    schedule()
  }

  return { start }
}
