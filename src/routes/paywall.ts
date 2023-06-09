import { Response, NextFunction, Request } from 'express'
import lnService from 'ln-service'

import { InvoiceResponse } from '../typings'
import {
  createInvoice,
  checkInvoiceStatus,
  createLsatFromInvoice,
  getLocation,
} from '../helpers'
import { Lsat } from 'lsat-js'

/**
 * @description This is the main paywall handler that will validate requests
 * that require payment for access. Normal lsats and hodl lsats both handled
 * here.
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 */
export default async function paywall(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const { headers } = req
  const hodl = req.boltwallConfig ? req.boltwallConfig.hodl : false

  // If missing LSAT in request to protected content
  // then we need to create a new invoice and corresponding LSAT
  let lsat: Lsat | undefined = undefined
  if (headers.authorization) {
    try {
      lsat = Lsat.fromToken(headers.authorization)
    } catch (e) {
      req.logger.error(
        'Could not create LSAT from given authorization header: %s. Error: %s',
        headers.authorization,
        e.message
      )
    }
  }

  // handle circumstance where there is no lsat or it is expired
  if (!headers.authorization || !lsat || lsat.isExpired()) {
    let invoice: InvoiceResponse, lsat
    try {
      invoice = await createInvoice(req)
      lsat = createLsatFromInvoice(req, invoice)
    } catch (e) {
      if (req?.boltwallConfig?.oauth && !req.query.auth_uri) {
        res.status(400)
        return next({ message: 'Missing auth_uri in query string for oauth request'})
      }
      // handle ln-service errors
      if (Array.isArray(e)) {
        req.logger.error('Problem generating invoice:', ...e)
      } else {
        req.logger.error('Problem generating invoice:', e.message)
      }
      res.status(500)
      return next({ message: 'Problem generating invoice' })
    }

    res.status(402)
    res.set({
      'WWW-Authenticate': lsat.toChallenge(),
    })
    req.logger.debug(
      `Request made from ${req.hostname} that requires payment. LSAT ID: ${lsat.id}`
    )
    return next({ message: 'Payment required' })
  }

  // challenge caveats should already have been verified at this point for oauth
  // so we can just continue to the paywall as all remaining checks are against our node
  if (req?.boltwallConfig?.oauth) {
    if (!lsat.isSatisfied()) req.logger.warning(`LSAT submitted to oauth server from ${req.ip} that is not satisfied with preimage but has valid signature.`)
    return next()
  }

  // If we got here then we have an LSAT and we want to check on the
  // status of the associated invoice, and return a 404 if it can't be found
  let payreq: string, status: string | undefined
  try {
    const invoice = await checkInvoiceStatus(
      lsat.paymentHash,
      req.lnd,
      req.opennode,
      req.cln
    )
    payreq = invoice.payreq
    status = invoice.status
  } catch (e) {
    // ln-service error
    if (
      Array.isArray(e) &&
      e[0] === 503 &&
      e[1] === 'UnexpectedLookupInvoiceErr'
    ) {
      res.status(404)
      return next({ message: 'Unable to lookup invoice for that LSAT' })
    } else if (Array.isArray(e)) {
      req.logger.error(
        'Problem looking up invoice %s: %s',
        lsat.paymentHash,
        e[2].err.details
      )
    }
    res.status(500)
    return next({
      message:
        'There was a server error when looking up the associated invoice.',
    })
  }

  if (!payreq || !status) {
    res.status(500)
    return next({
      message:
        'There was a server error when looking up the associated invoice.',
    })
  }

  // server received an lsat but it's not validated with preimage yet
  if (!lsat.paymentPreimage) {
    // for hodl paywalls, held status and no preimage is valid
    // so we can pass it to the next handler
    if (status === 'held' && hodl) {
      req.logger.debug(`Valid hodl request made with LSAT ${lsat.id}`)
      return next()
    } else if (!hodl || status === 'unpaid') {
      if (hodl) {
        req.logger.debug(
          'HODL invoice %s unpaid for LSAT %s',
          lsat.paymentHash,
          lsat.id
        )
      } else {
        req.logger.info(
          'Request made from %s with LSAT but no secret',
          getLocation(req)
        )
      }
      // for non-hodl paywalls need to return a 402
      // or hodl paywalls that are not paid
      lsat.addInvoice(payreq)
      res.status(402)

      res.set({
        'WWW-Authenticate': lsat.toChallenge(),
      })
      return next({ message: 'Payment required' })
    }
  } else if (hodl) {
    // for hodl requests that have passed the prior conditions
    // (has preimage in the LSAT or hodl invoice is not held)
    if (status === 'paid') {
      // hodl lsat with paid/settled invoice is considered expired
      res.status(401)
      return next({
        message: 'Unauthorized: HODL invoice paid and LSAT expired',
      })
    } else if (status === 'held' && lsat.paymentPreimage) {
      // if status is held (i.e. paid but not settled) and LSAT contains preimage
      // the invoice should be settled and the request authorized
      try {
        await lnService.settleHodlInvoice({
          lnd: req.lnd,
          secret: lsat.paymentPreimage,
        })
        return next()
      } catch (e) {
        // lnService returns errors as array
        if (Array.isArray(e) && e[2]) {
          req.logger.error('There was an error settling a hodl invoice:', ...e)
          res.status(e[0])
          return next({ message: e[1], details: e[2].err.details })
        }
        req.logger.error(
          'There was an error settling a hodl invoice: %s',
          e.message
        )

        res.status(500)
        return next({
          message:
            'The server encountered an error processing the hodl invoice. Please try again later or contact server admin.',
        })
      }
    }
  }
  req.logger.debug('Request made with valid LSAT token with id: %s', lsat.id)
  next()
}
