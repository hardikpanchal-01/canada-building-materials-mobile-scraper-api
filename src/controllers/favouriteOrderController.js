const favouriteOrderService = require('../services/favouriteOrderService');

const FALLBACK_TZ = 'America/Chicago';

function formatToUserTz(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * @swagger
 * /api/orders/{order_id}/favourite:
 *   post:
 *     summary: Toggle favourite/unfavourite an order
 *     description: |
 *       Toggles the favourite status of an order for the authenticated user.
 *       - If the order is **not** favourited, it will be **added** to favourites.
 *       - If the order is **already** favourited, it will be **removed** from favourites.
 *     tags: [Favourites]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: order_id
 *         required: true
 *         schema:
 *           type: string
 *         description: The order ID to toggle favourite status
 *     responses:
 *       200:
 *         description: Favourite status toggled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Order added to favourites"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order_id:
 *                       type: string
 *                       description: The order ID that was toggled
 *                     is_favourite:
 *                       type: boolean
 *                       description: Current favourite status (true = favourited, false = unfavourited)
 *       400:
 *         description: Missing order_id parameter
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function toggleFavourite(req, res) {
  try {
    const { order_id } = req.params;
    const userId = req.user.id;

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: 'order_id is required'
      });
    }

    const result = await favouriteOrderService.toggleFavourite(userId, order_id);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        order_id,
        is_favourite: result.is_favourite
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to toggle favourite',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/orders/favourites:
 *   get:
 *     summary: Get all favourite orders
 *     description: Retrieves all favourite orders for the authenticated user with order details including status, quantities, customer info, and delivery address.
 *     tags: [Favourites]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Favourite orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Favourite orders retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     favourites:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           favourite_id:
 *                             type: string
 *                             description: Unique favourite record ID
 *                           favourited_at:
 *                             type: string
 *                             format: date-time
 *                             description: When the order was favourited
 *                           order_id:
 *                             type: string
 *                           order_code:
 *                             type: string
 *                           order_date:
 *                             type: string
 *                             format: date
 *                           customer_name:
 *                             type: string
 *                           project_name:
 *                             type: string
 *                           delivery_address:
 *                             type: string
 *                           ordered_qty:
 *                             type: number
 *                           delivered_qty:
 *                             type: number
 *                           remaining_qty:
 *                             type: number
 *                           status:
 *                             type: string
 *                             enum: [Normal, Will Call, Hold Delivery, Completed, Wait List, In Progress, Canceled]
 *                     total:
 *                       type: integer
 *                       description: Total number of favourite orders
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getFavourites(req, res) {
  try {
    const userId = req.user.id;

    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || []
    };

    const tz = req.user?.timezone || null;
    const result = await favouriteOrderService.getFavourites(userId, userAccess);

    if (tz && result.favourites) {
      result.favourites = result.favourites.map(f => ({
        ...f,
        favourited_at: formatToUserTz(f.favourited_at, tz),
      }));
    }

    return res.status(200).json({
      success: true,
      message: 'Favourite orders retrieved successfully',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve favourite orders',
      error: error.message
    });
  }
}

module.exports = {
  toggleFavourite,
  getFavourites
};
