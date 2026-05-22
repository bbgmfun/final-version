const mongoose = require('mongoose');

const hotelSchema = new mongoose.Schema(
  {
    _id: { type: String }, // human-readable slug
    name: { type: String, required: true },
    city: { type: String, required: true, index: true },
    country: { type: String, default: 'Türkiye' },
    description: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    location: {
      lat: { type: Number },
      lng: { type: Number }
    },
    amenities: [{ type: String }],
    rating: { type: Number, default: 0 }
  },
  { timestamps: true, _id: false }
);

const roomInventorySchema = new mongoose.Schema(
  {
    hotelId: { type: String, required: true, index: true },
    roomType: { type: String, enum: ['Standard', 'Aile', 'Deluxe', 'Suite'], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    totalRooms: { type: Number, required: true, min: 0 },
    availableRooms: { type: Number, required: true, min: 0 },
    pricePerNight: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['Bos', 'Dolu'], default: 'Bos' }
  },
  { timestamps: true }
);
roomInventorySchema.index({ hotelId: 1, roomType: 1, startDate: 1, endDate: 1 });

const reservationSchema = new mongoose.Schema(
  {
    hotelId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    userEmail: { type: String, required: true },
    roomType: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    guests: { type: Number, default: 2 },
    totalPrice: { type: Number, required: true },
    status: { type: String, enum: ['confirmed', 'cancelled'], default: 'confirmed' }
  },
  { timestamps: true }
);

const Hotel = mongoose.model('Hotel', hotelSchema);
const RoomInventory = mongoose.model('RoomInventory', roomInventorySchema);
const Reservation = mongoose.model('Reservation', reservationSchema);

module.exports = { Hotel, RoomInventory, Reservation };
