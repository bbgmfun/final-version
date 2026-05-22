const { Hotel, RoomInventory } = require('./models');

async function seedSampleHotels() {
  const count = await Hotel.estimatedDocumentCount();
  console.log('[hotel] seeding sample hotels — current count =', count);

  const samples = [
    {
      _id: 'hotel-swiss',
      name: 'Hotel Swiss',
      city: 'Bodrum',
      country: 'Türkiye',
      description: 'Bodrum sahilinde Alp esintili butik otel',
      imageUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800',
      location: { lat: 37.0344, lng: 27.4305 },
      amenities: ['Pool', 'WiFi', 'Breakfast', 'Spa'],
      rating: 9.2
    },
    {
      _id: 'hyde-bodrum',
      name: 'Hyde Bodrum - Yetişkin Oteli',
      city: 'Bodrum',
      country: 'Türkiye',
      description: 'Torba mevkiinde sadece yetişkinlere özel ultra-her şey dahil',
      imageUrl: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800',
      location: { lat: 37.0719, lng: 27.4536 },
      amenities: ['Pool', 'WiFi', 'All-Inclusive', 'Adults-only'],
      rating: 9.6
    },
    {
      _id: 'mgallery-yalikavak',
      name: 'MGallery The Bodrum Hotel Yalıkavak',
      city: 'Bodrum',
      country: 'Türkiye',
      description: 'Yalıkavak marina manzaralı butik 5-yıldız',
      imageUrl: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800',
      location: { lat: 37.1085, lng: 27.2945 },
      amenities: ['Pool', 'WiFi', 'Spa', 'Beach'],
      rating: 9.6
    },
    {
      _id: 'roma-plaza',
      name: 'Hotel Roma Plaza',
      city: 'Rome',
      country: 'Italy',
      description: 'City Centre boutique with rooftop pool',
      imageUrl: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=800',
      location: { lat: 41.9028, lng: 12.4964 },
      amenities: ['WiFi', 'Breakfast', 'Pool'],
      rating: 4.5
    },
    {
      _id: 'grand-monti',
      name: 'Grand Hotel Monti',
      city: 'Rome',
      country: 'Italy',
      description: 'Located in the historic Monti district',
      imageUrl: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800',
      location: { lat: 41.8947, lng: 12.4922 },
      amenities: ['WiFi', 'Breakfast', 'Pool'],
      rating: 4.3
    }
  ];

  // Insert base samples if they don't already exist
  const toInsert = [];
  for (const s of samples) {
    const exists = await Hotel.exists({ _id: s._id });
    if (!exists) toInsert.push(s);
  }
  if (toInsert.length) await Hotel.insertMany(toInsert);

  // Add more demo cities/results if missing. Keep canonical city names ASCII so
  // search aliases can map Turkish spellings like "İstanbul" and "İzmir".
  const extra = [
    {
      _id: 'trastevere-garden',
      name: 'Trastevere Garden Rooms',
      city: 'Rome',
      country: 'Italy',
      description: 'Trastevere sokaklarına yakın bahçeli şehir oteli',
      imageUrl: 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=800',
      location: { lat: 41.8896, lng: 12.4702 },
      amenities: ['WiFi', 'Breakfast', 'Garden'],
      rating: 8.9
    },
    {
      _id: 'istanbul-bosphorus',
      name: 'Bosphorus Boutique Hotel',
      city: 'Istanbul',
      country: 'Türkiye',
      description: 'Boğaz manzaralı butik otel, şehir merkezine yakın',
      imageUrl: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800',
      location: { lat: 41.0151, lng: 29.0759 },
      amenities: ['WiFi', 'Breakfast', 'Rooftop'],
      rating: 8.8
    },
    {
      _id: 'galata-view',
      name: 'Galata View Suites',
      city: 'Istanbul',
      country: 'Türkiye',
      description: 'Galata çevresinde teraslı modern şehir oteli',
      imageUrl: 'https://images.unsplash.com/photo-1524231757912-21f4fe3a7200?w=800',
      location: { lat: 41.0256, lng: 28.9744 },
      amenities: ['WiFi', 'Rooftop', 'Breakfast'],
      rating: 9.1
    },
    {
      _id: 'sultanahmet-terrace',
      name: 'Sultanahmet Terrace Hotel',
      city: 'Istanbul',
      country: 'Türkiye',
      description: 'Tarihi yarımadada kahvaltılı ve merkezi konaklama',
      imageUrl: 'https://images.unsplash.com/photo-1641128324972-af3212f0f6bd?w=800',
      location: { lat: 41.0054, lng: 28.9768 },
      amenities: ['WiFi', 'Breakfast', 'Terrace'],
      rating: 8.7
    },
    {
      _id: 'izmir-seaside',
      name: 'Izmir Seaside Hotel',
      city: 'Izmir',
      country: 'Türkiye',
      description: 'Kordon boyunca modern otel, denize yürüme mesafesinde',
      imageUrl: 'https://images.unsplash.com/photo-1501117716987-c8e2b0d0f3f6?w=800',
      location: { lat: 38.4237, lng: 27.1428 },
      amenities: ['WiFi', 'Breakfast', 'Sea View'],
      rating: 8.4
    },
    {
      _id: 'alsancak-residence',
      name: 'Alsancak Residence',
      city: 'Izmir',
      country: 'Türkiye',
      description: 'Alsancak merkezde iş ve tatil için pratik apart otel',
      imageUrl: 'https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800',
      location: { lat: 38.4381, lng: 27.1441 },
      amenities: ['WiFi', 'Breakfast', 'Kitchenette'],
      rating: 8.6
    },
    {
      _id: 'cesme-bay-izmir',
      name: 'Çeşme Bay Hotel',
      city: 'Izmir',
      country: 'Türkiye',
      description: 'Çeşme koylarına yakın havuzlu yaz oteli',
      imageUrl: 'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=800',
      location: { lat: 38.3228, lng: 26.3032 },
      amenities: ['Pool', 'WiFi', 'Beach'],
      rating: 9.0
    }
  ];
  for (const s of extra) {
    const exists = await Hotel.exists({ _id: s._id });
    if (!exists) {
      await Hotel.create(s);
    }
    samples.push(s);
  }

  // 180-day inventory window starting today, two room types per hotel.
  // Upsert by hotel/room/window so redeploys do not keep duplicating rows.
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start.getTime() + 1000 * 60 * 60 * 24 * 180);

  const invs = [];
  for (const h of samples) {
    invs.push({
      hotelId: h._id,
      roomType: 'Standard',
      startDate: start,
      endDate: end,
      totalRooms: 10,
      availableRooms: 12,
      pricePerNight: basePriceFor(h),
      status: 'Bos'
    });
    invs.push({
      hotelId: h._id,
      roomType: 'Aile',
      startDate: start,
      endDate: end,
      totalRooms: 6,
      availableRooms: 6,
      pricePerNight: Math.round(basePriceFor(h) * 1.42),
      status: 'Bos'
    });
  }
  await RoomInventory.bulkWrite(invs.map((inv) => ({
    updateOne: {
      filter: {
        hotelId: inv.hotelId,
        roomType: inv.roomType,
        startDate: inv.startDate,
        endDate: inv.endDate
      },
      update: { $setOnInsert: inv },
      upsert: true
    }
  })));
  console.log('[hotel] seeded', samples.length, 'hotels and', invs.length, 'inventory rows');
}

function basePriceFor(h) {
  const byCity = { Bodrum: 10948, Rome: 12800, Istanbul: 7600, Izmir: 6900 };
  const offset = Math.round(((h.rating || 8) - 8) * 900);
  return Math.max(4200, (byCity[h.city] || 8500) + offset);
}

module.exports = { seedSampleHotels };
